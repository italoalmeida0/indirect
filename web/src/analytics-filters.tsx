import { For, Show, createMemo, createResource, createSignal, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { shift } from "@floating-ui/dom";
import { api } from "./api";
import { anchorFloat } from "./floating";
import { Icon, Icons } from "./ui";
import { calendarPeriods, localDateTime, presetRange, rangeLabel, rangeUnit, relativePeriods } from "./analytics-range";

interface FilterOption { value: string; label: string; count: number }
interface FilterCategory { id: string; label: string; icon: string; options: FilterOption[] }
const categoryIcons: Record<string, string> = { model: "lucide:box", provider_id: "lucide:server", key_id: "lucide:key", proto: "lucide:arrow-left-right", upstream_model: "lucide:layers", provider_key_id: "lucide:shield", user_id: "lucide:users" };
type Mode = "include" | "exclude";
type Selection = Record<string, { include: string[]; exclude: string[] }>;

export function createAnalyticsFilters(admin = false) {
  const [range, setRange] = createSignal(presetRange("14d"));
  const [selection, setSelection] = createSignal<Selection>({});
  const [options, { refetch }] = createResource(async () => {
    const result = await api<{ categories: FilterCategory[] }>("GET", admin ? "/api/admin/usage-filter-options" : "/api/usage/filter-options");
    return result.categories;
  });
  const categories = () => options.error ? [] : options() ?? [];
  const query = createMemo(() => {
    const period = range();
    return new URLSearchParams({ from: period.from === null ? "all" : String(period.from), to: String(period.to), selection: JSON.stringify(selection()) }).toString();
  });
  const toggle = (field: string, mode: Mode, value: string) => setSelection((current) => {
    const existing = current[field] ?? { include: [], exclude: [] };
    const other = mode === "include" ? "exclude" : "include";
    const next = { ...existing, [mode]: existing[mode].includes(value) ? existing[mode].filter((v) => v !== value) : [...existing[mode], value], [other]: existing[other].filter((v) => v !== value) };
    const result = { ...current, [field]: next };
    if (!next.include.length && !next.exclude.length) delete result[field];
    return result;
  });
  const clear = (field?: string, mode?: Mode) => setSelection((current) => {
    if (!field) return {};
    const result = { ...current };
    if (mode && result[field]) {
      result[field] = { ...result[field]!, [mode]: [] };
      if (!result[field]!.include.length && !result[field]!.exclude.length) delete result[field];
    } else delete result[field];
    return result;
  });
  return { range, setRange, selection, query, categories, options, refetch, toggle, clear, label: () => rangeLabel(range()), unit: () => rangeUnit(range()) };
}

function FloatingPanel(props: { anchor: HTMLElement; label: string; wide?: boolean; close: (focus?: boolean) => void; children: JSX.Element }) {
  let panel!: HTMLDivElement;
  onMount(() => {
    const cleanup = anchorFloat(props.anchor, panel, { placement: "bottom-end", gap: 8, padding: 12, maxHeight: 640, middleware: [shift({ padding: 12, crossAxis: true })] });
    const outside = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !props.anchor.contains(event.target)) props.close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.close(true); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    const frame = requestAnimationFrame(() => (panel.querySelector<HTMLElement>("[data-initial-focus]") ?? panel.querySelector<HTMLElement>("[data-nav]"))?.focus({ preventScroll: true }));
    onCleanup(() => {
      cleanup(); cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    });
  });
  const navigate: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || (event.target as HTMLElement).closest(".analytics-calendar, input[type='datetime-local']")) return;
    if (event.target instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>("[data-nav]")).filter((el) => el.getClientRects().length && !el.hasAttribute("disabled"));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <Portal><div ref={panel} role="dialog" aria-label={props.label} class={`analytics-popover anim-float-in ${props.wide ? "analytics-popover-wide" : ""}`} onKeyDown={navigate}>{props.children}</div></Portal>;
}

function SearchField(props: { value: string; onInput: (value: string) => void; placeholder: string; initial?: boolean }) {
  return <div class="analytics-search">
    <Icon name={Icons.search} size={15} />
    <input aria-label={props.placeholder} placeholder={props.placeholder} value={props.value} data-initial-focus={props.initial ? "" : undefined} onInput={(event) => props.onInput(event.currentTarget.value)} autocomplete="off" spellcheck={false} />
    <Show when={props.value}><button type="button" class="analytics-icon-button" aria-label="Clear search" onClick={() => props.onInput("")}><Icon name={Icons.x} size={13} /></button></Show>
  </div>;
}

function Calendar(props: { from: string; to: string; setFrom: (value: string) => void; setTo: (value: string) => void }) {
  const initial = new Date(props.from || Date.now());
  const [month, setMonth] = createSignal(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [choosingEnd, setChoosingEnd] = createSignal(false);
  const [hover, setHover] = createSignal("");
  const dateKey = (date: Date) => localDateTime(date.getTime()).slice(0, 10);
  const fromDay = () => props.from.slice(0, 10);
  const toDay = () => choosingEnd() && hover() ? hover() : props.to.slice(0, 10);
  const days = createMemo(() => {
    const start = new Date(month());
    start.setDate(1 - start.getDay());
    return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  });
  const move = (amount: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  const select = (day: string) => {
    if (!choosingEnd()) {
      props.setFrom(`${day}T00:00`); props.setTo(`${day}T23:59`); setChoosingEnd(true);
    } else {
      const start = fromDay();
      props.setFrom(`${day < start ? day : start}T00:00`);
      props.setTo(`${day < start ? start : day}T23:59`);
      setChoosingEnd(false); setHover("");
    }
  };
  const navigate = (event: KeyboardEvent, date: Date) => {
    const amounts: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -date.getDay(), End: 6 - date.getDay() };
    if (!(event.key in amounts) && event.key !== "PageUp" && event.key !== "PageDown") return;
    event.preventDefault(); event.stopPropagation();
    const next = new Date(date);
    if (event.key === "PageUp" || event.key === "PageDown") next.setMonth(next.getMonth() + (event.key === "PageUp" ? -1 : 1));
    else next.setDate(next.getDate() + amounts[event.key]!);
    if (next.getMonth() !== month().getMonth() || next.getFullYear() !== month().getFullYear()) setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-calendar-date="${dateKey(next)}"]`)?.focus());
  };
  return <div class="analytics-calendar">
    <div class="analytics-calendar-heading">
      <button type="button" aria-label="Previous month" class="analytics-icon-button" onClick={() => move(-1)}><Icon name="lucide:chevron-left" size={16} /></button>
      <span aria-live="polite">{month().toLocaleDateString("en", { month: "long", year: "numeric" })}</span>
      <button type="button" aria-label="Next month" class="analytics-icon-button" onClick={() => move(1)}><Icon name={Icons.chevronRight} size={16} /></button>
    </div>
    <div class="analytics-calendar-grid" role="group" aria-label="Choose start and end dates">
      <For each={["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]}>{(day) => <span class="analytics-weekday">{day}</span>}</For>
      <For each={days()}>{(date) => {
        const key = dateKey(date);
        const selected = () => key === fromDay() || key === toDay();
        const between = () => key > (fromDay() < toDay() ? fromDay() : toDay()) && key < (fromDay() < toDay() ? toDay() : fromDay());
        return <button type="button" data-calendar-date={key} aria-label={date.toLocaleDateString("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} aria-pressed={selected()} tabIndex={key === (fromDay().slice(0, 7) === dateKey(month()).slice(0, 7) ? fromDay() : dateKey(month())) ? 0 : -1}
          class={`analytics-day ${date.getMonth() !== month().getMonth() ? "is-outside" : ""} ${selected() ? "is-selected" : between() ? "is-between" : ""} ${key === dateKey(new Date()) ? "is-today" : ""}`}
          onClick={() => select(key)} onPointerEnter={() => { if (choosingEnd()) setHover(key); }} onKeyDown={(event) => navigate(event, date)}>{date.getDate()}</button>;
      }}</For>
    </div>
    <p class="analytics-calendar-hint" aria-live="polite">{choosingEnd() ? "Choose the end date" : "Choose a start date, then an end date"}</p>
  </div>;
}

export function AnalyticsToolbar(props: { filters: ReturnType<typeof createAnalyticsFilters> }) {
  const f = props.filters;
  const [open, setOpen] = createSignal<"filters" | "period" | null>(null);
  const [active, setActive] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("include");
  const [categorySearch, setCategorySearch] = createSignal("");
  const [optionSearch, setOptionSearch] = createSignal("");
  const [custom, setCustom] = createSignal(false);
  const [draftFrom, setDraftFrom] = createSignal("");
  const [draftTo, setDraftTo] = createSignal("");
  const [calendarVersion, setCalendarVersion] = createSignal(0);
  let filterButton!: HTMLButtonElement;
  let periodButton!: HTMLButtonElement;
  const id = createUniqueId();
  const count = () => Object.values(f.selection()).reduce((sum, entry) => sum + entry.include.length + entry.exclude.length, 0);
  const current = () => f.categories().find((category) => category.id === active());
  const categories = () => f.categories().filter((category) => category.label.toLowerCase().includes(categorySearch().toLowerCase()));
  const visibleOptions = createMemo(() => (current()?.options ?? []).filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(optionSearch().toLowerCase())));
  const chips = createMemo(() => Object.entries(f.selection()).flatMap(([field, selection]) => (["include", "exclude"] as const).flatMap((mode) => {
    const category = f.categories().find((c) => c.id === field);
    const labels = selection[mode].map((value) => category?.options.find((option) => option.value === value)?.label ?? value);
    return labels.length ? [{ field, mode, category: category?.label ?? field, labels }] : [];
  })));
  const close = (focus = false) => {
    const button = open() === "filters" ? filterButton : periodButton;
    setOpen(null);
    if (focus) button.focus({ preventScroll: true });
  };
  const chooseCategory = (field: string) => {
    setActive(field); setOptionSearch("");
    requestAnimationFrame(() => document.getElementById(`${id}-filters`)?.querySelector<HTMLInputElement>(".analytics-options input")?.focus({ preventScroll: true }));
  };
  const periodText = () => {
    const r = f.range();
    const format = (ts: number) => new Date(ts).toLocaleDateString("en", { month: "short", day: "numeric", ...(new Date(ts).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
    return r.from === null ? "All history" : `${format(r.from)} – ${format(r.to - 1)}`;
  };
  const exactRange = () => f.range().from === null ? `All history through ${new Date(f.range().to).toLocaleString()}` : `${new Date(f.range().from!).toLocaleString()} – ${new Date(f.range().to).toLocaleString()}`;
  const timezone = Intl.DateTimeFormat("en", { timeZoneName: "shortOffset" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "Local time";
  const applyPreset = (preset: string) => { f.setRange(presetRange(preset)); close(true); };
  const beginCustom = () => {
    const range = f.range();
    setDraftFrom(localDateTime(range.from ?? Date.now() - 7 * 86_400_000));
    setDraftTo(localDateTime(range.to - 1));
    setCalendarVersion((v) => v + 1); setCustom(true);
    requestAnimationFrame(() => document.getElementById(`${id}-period`)?.querySelector<HTMLButtonElement>(".analytics-day[aria-pressed='true']")?.focus({ preventScroll: true }));
  };
  const validDraft = () => Number.isFinite(new Date(draftFrom()).getTime()) && Number.isFinite(new Date(draftTo()).getTime()) && new Date(draftFrom()).getTime() <= new Date(draftTo()).getTime();
  const applyCustom = () => {
    if (!validDraft()) return;
    f.setRange({ preset: "custom", from: new Date(draftFrom()).getTime(), to: new Date(draftTo()).getTime() + 60_000 });
    close(true);
  };
  const periodRow = (period: { id: string; label: string }, badge?: string) => <button type="button" data-nav data-initial-focus={f.range().preset === period.id ? "" : undefined} class={`analytics-menu-row ${f.range().preset === period.id ? "is-active" : ""}`} onClick={() => applyPreset(period.id)}>
    <Show when={badge}><span class="analytics-period-code">{badge}</span></Show><span>{period.label}</span><Show when={f.range().preset === period.id}><Icon name={Icons.check} size={15} class="ml-auto" /></Show>
  </button>;

  return <div class="analytics-toolbar" aria-label="Analytics filters">
    <div class="analytics-controls">
      <button ref={filterButton} type="button" class={`analytics-control ${count() || open() === "filters" ? "is-active" : ""}`} aria-label="Filter usage" aria-haspopup="dialog" aria-expanded={open() === "filters"} aria-controls={`${id}-filters`} onClick={() => { if (open() === "filters") close(); else { setOpen("filters"); setActive(""); setCategorySearch(""); } }}>
        <Icon name="lucide:list-filter" size={16} /><span>Filter</span><Show when={count()}><span class="analytics-filter-count">{count()}</span></Show>
      </button>
      <button ref={periodButton} type="button" class={`analytics-control analytics-period-trigger ${open() === "period" ? "is-active" : ""}`} title={exactRange()} aria-label={`Time range: ${f.label()}`} aria-haspopup="dialog" aria-expanded={open() === "period"} aria-controls={`${id}-period`} onClick={() => { if (open() === "period") close(); else { setCustom(false); setOpen("period"); } }}>
        <Icon name="lucide:calendar-days" size={15} /><span class="analytics-range-name">{f.label()}</span><span class="analytics-range-dates">{periodText()}</span><Icon name={Icons.chevronDown} size={13} class="text-ink-500" />
      </button>
      <span class="analytics-timezone" title="Calendar dates and times use your local timezone; charts use UTC"><Icon name="lucide:globe" size={12} />{timezone}</span>
    </div>
    <Show when={chips().length}>
      <div class="analytics-chips" aria-live="polite">
        <For each={chips()}>{(chip) => <div class={`analytics-chip ${chip.mode === "exclude" ? "is-exclusion" : ""}`}>
          <button type="button" class="analytics-chip-label" title={chip.labels.join(", ")} onClick={() => { setOpen("filters"); chooseCategory(chip.field); setMode(chip.mode); }}><span>{chip.category}</span><span class="analytics-chip-operator">{chip.mode === "include" ? "is" : "is not"}</span><strong>{chip.labels.slice(0, 2).join(", ")}</strong><Show when={chip.labels.length > 2}><span>+{chip.labels.length - 2}</span></Show></button>
          <button type="button" class="analytics-chip-remove" aria-label={`Remove ${chip.category} ${chip.mode} filter`} onClick={() => f.clear(chip.field, chip.mode)}><Icon name={Icons.x} size={12} /></button>
        </div>}</For>
        <button type="button" class="analytics-clear" onClick={() => f.clear()}>Clear all</button>
      </div>
    </Show>
    <Show when={open() === "filters"}>
      <FloatingPanel anchor={filterButton} label="Usage filters" wide={!!active()} close={close}>
        <div id={`${id}-filters`} class={`analytics-filter-layout ${active() ? "has-detail" : ""}`}>
          <div class="analytics-categories">
            <SearchField value={categorySearch()} onInput={setCategorySearch} placeholder="Search filters…" initial />
            <div class="analytics-category-list">
              <Show when={!f.options.loading} fallback={<p class="analytics-empty">Loading filters…</p>}>
                <Show when={!f.options.error} fallback={<div class="analytics-empty">Could not load filters.<button type="button" class="analytics-clear block mx-auto mt-2" onClick={() => void f.refetch()}>Try again</button></div>}>
                  <For each={categories()}>{(category) => {
                    const selected = () => (f.selection()[category.id]?.include.length ?? 0) + (f.selection()[category.id]?.exclude.length ?? 0);
                    return <button type="button" data-nav class={`analytics-menu-row ${active() === category.id ? "is-active" : ""}`} aria-label={`Filter by ${category.label}`} aria-pressed={active() === category.id} onClick={() => chooseCategory(category.id)}><Icon name={categoryIcons[category.id] ?? Icons.layers} size={15} class="text-ink-400" /><span>{category.label}</span><Show when={selected()}><span class="analytics-category-count">{selected()}</span></Show><Icon name={Icons.chevronRight} size={14} class="ml-auto text-ink-500" /></button>;
                  }}</For>
                  <Show when={!categories().length}><p class="analytics-empty">No filters found.</p></Show>
                </Show>
              </Show>
            </div>
            <div class="analytics-menu-footer"><span>Narrow your view</span><kbd>esc</kbd></div>
          </div>
          <Show when={current()}>{(category) => <div class="analytics-options">
            <div class="analytics-option-heading"><button type="button" class="analytics-icon-button" aria-label="Back to filters" onClick={() => setActive("")}><Icon name="lucide:chevron-left" size={15} /></button><span>{category().label}</span><span class="analytics-result-count">{category().options.length.toLocaleString()} available</span></div>
            <div class="analytics-mode" role="group" aria-label="Filter mode"><For each={["include", "exclude"] as const}>{(value) => <button type="button" aria-pressed={mode() === value} class={mode() === value ? "is-selected" : ""} onClick={() => setMode(value)}><Icon name={value === "include" ? "lucide:plus" : "lucide:minus"} size={13} />{value === "include" ? "Include" : "Exclude"}</button>}</For></div>
            <SearchField value={optionSearch()} onInput={setOptionSearch} placeholder={`Search ${category().label.toLowerCase()}…`} />
            <div class="analytics-option-list" role="group" aria-label={`${mode() === "include" ? "Include" : "Exclude"} ${category().label}`}>
              <For each={visibleOptions()}>{(option) => {
                const selected = () => f.selection()[category().id]?.[mode()].includes(option.value) ?? false;
                const other = () => f.selection()[category().id]?.[mode() === "include" ? "exclude" : "include"].includes(option.value) ?? false;
                return <button type="button" data-nav class={`analytics-menu-row analytics-option ${selected() ? "is-active" : ""}`} aria-pressed={selected()} title={option.value || "Unknown"} onClick={() => f.toggle(category().id, mode(), option.value)}>
                  <span class={`analytics-checkbox ${selected() ? "is-checked" : ""}`}><Show when={selected()}><Icon name={mode() === "include" ? Icons.check : "lucide:minus"} size={11} strokeWidth={2.5} /></Show></span>
                  <span class="analytics-option-name">{option.label}</span><Show when={other()}><Icon name={mode() === "include" ? "lucide:minus" : "lucide:plus"} size={12} class="text-ink-500" /></Show><span class="analytics-option-count">{option.count.toLocaleString()}</span>
                </button>;
              }}</For>
              <Show when={!visibleOptions().length}><div class="analytics-empty"><Icon name={Icons.search} size={22} class="mb-2 text-ink-500" /><p>{optionSearch() ? "No matches found" : "No usage recorded yet"}</p><p class="mt-1 text-ink-500">{optionSearch() ? "Try a different search." : "Options appear as requests arrive."}</p></div></Show>
            </div>
            <div class="analytics-menu-footer"><span>{f.selection()[category().id]?.[mode()].length ?? 0} {mode() === "include" ? "included" : "excluded"}</span><button type="button" class="analytics-clear" disabled={!f.selection()[category().id]?.[mode()].length} onClick={() => f.clear(category().id, mode())}>Reset</button></div>
          </div>}</Show>
        </div>
      </FloatingPanel>
    </Show>
    <Show when={open() === "period"}>
      <FloatingPanel anchor={periodButton} label="Time range" close={close}>
        <div id={`${id}-period`}>
          <Show when={!custom()} fallback={<>
            <div class="analytics-custom-heading"><button type="button" class="analytics-icon-button" aria-label="Back to presets" onClick={() => setCustom(false)}><Icon name="lucide:chevron-left" size={15} /></button><strong>Custom range</strong><span>{timezone}</span></div>
            <Show when={calendarVersion()} keyed>{(_version) => <Calendar from={draftFrom()} to={draftTo()} setFrom={setDraftFrom} setTo={setDraftTo} />}</Show>
            <div class="analytics-date-fields"><label>Start<input type="datetime-local" aria-label="Start date and time" value={draftFrom()} onInput={(e) => setDraftFrom(e.currentTarget.value)} /></label><label>End<input type="datetime-local" aria-label="End date and time" value={draftTo()} onInput={(e) => setDraftTo(e.currentTarget.value)} /></label></div>
            <Show when={!validDraft()}><p class="analytics-date-error" role="alert">End must be on or after the start.</p></Show>
            <div class="analytics-custom-actions"><button type="button" class="analytics-cancel" onClick={() => close(true)}>Cancel</button><button type="button" class="analytics-apply" disabled={!validDraft()} onClick={applyCustom}>Apply range<Icon name="lucide:arrow-right" size={14} /></button></div>
          </>}>
            <div class="analytics-period-heading"><span>Time range</span><span>{timezone}</span></div>
            <div class="analytics-presets"><For each={relativePeriods}>{(period) => periodRow(period, period.id)}</For></div>
            <div class="analytics-calendar-presets"><For each={calendarPeriods}>{(period) => periodRow(period)}</For></div>
            <div class="analytics-presets analytics-period-bottom">{periodRow({ id: "all", label: "All time" })}<button type="button" data-nav class="analytics-menu-row" onClick={beginCustom}><Icon name="lucide:calendar-range" size={15} /><span>Custom range…</span><Icon name={Icons.chevronRight} size={14} class="ml-auto text-ink-500" /></button></div>
          </Show>
        </div>
      </FloatingPanel>
    </Show>
  </div>;
}
