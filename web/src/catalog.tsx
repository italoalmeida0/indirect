import { Show, batch, createEffect, createMemo, createResource, createSignal, onCleanup, type Accessor, type JSX } from "solid-js";
import { api } from "./api";
import { AnalyticsToolbar, createAnalyticsFilters } from "./analytics-filters";
import { serverDatasource } from "./aggrid";
import { Icon, Icons, Select, fmtNum } from "./ui";

type Sort = Array<{ colId: string; sort: string }>;
interface SortOption { value: string; label: string }
interface Page<T> { rows: T[]; total: number }
const PAGE_SIZE = 25;

/** A single query drives desktop blocks and mobile pages. The first page is
 * shared with the count, identical reads coalesce, and scope changes cancel
 * obsolete requests. No mobile-only filtering of a truncated result set. */
export function createCatalog<T>(config: { path: string; result: string; label: string; sort: SortOption[]; storageKey?: string; cards?: boolean; cursor?: boolean; extra?: Accessor<Record<string, string>> }) {
  const filters = createAnalyticsFilters(false, { endpoint: `${config.path}/filter-options`, initialPreset: "all" });
  const media = window.matchMedia("(max-width: 767px)");
  const [mobile, setMobile] = createSignal(media.matches);
  const resize = () => setMobile(media.matches);
  media.addEventListener("change", resize);
  const [search, setSearchValue] = createSignal("");
  const [settledSearch, setSettledSearch] = createSignal("");
  let initialSort: Sort = [];
  try { const stored = JSON.parse(localStorage.getItem(config.storageKey ?? "") ?? "{}").sortModel; if (Array.isArray(stored)) initialSort = stored.filter((entry) => typeof entry?.colId === "string" && entry.colId.length <= 64 && (entry.sort === "asc" || entry.sort === "desc")).slice(0, 8); } catch {}
  const [sort, setSortValue] = createSignal<Sort>(initialSort);
  const [paging, setPaging] = createSignal({ scope: "", page: 1 });
  const [version, setVersion] = createSignal(0);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, { scope: string; abort: AbortController; promise: Promise<Page<T>> }>();
  const cursors = new Map<number, { ts: number; id: number }>();
  const query = createMemo(() => {
    const params = new URLSearchParams(filters.query());
    if (settledSearch()) params.set("search", settledSearch());
    for (const [key, value] of Object.entries(config.extra?.() ?? {})) params.set(key, value);
    if (sort().length) params.set("sort", JSON.stringify(sort()));
    return params.toString();
  });
  const scope = createMemo(() => `${version()}:${query()}`);
  const page = () => paging().scope === scope() ? paging().page : 1;
  const setPage = (next: number | ((current: number) => number)) => setPaging({ scope: scope(), page: typeof next === "function" ? next(page()) : next });
  createEffect(() => {
    const current = scope();
    cursors.clear();
    for (const [key, entry] of cache) if (entry.scope !== current) { entry.abort.abort(); cache.delete(key); }
  });
  const load = (offset: number, limit: number, requestedSort = sort()): Promise<Page<T>> => {
    const params = new URLSearchParams(query());
    if (requestedSort.length) params.set("sort", JSON.stringify(requestedSort)); else params.delete("sort");
    params.set("limit", String(Math.min(limit, 500))); params.set("offset", String(offset));
    const cursor = config.cursor && (!requestedSort.length || (requestedSort.length === 1 && requestedSort[0]!.colId === "ts" && requestedSort[0]!.sort === "desc")) ? cursors.get(offset - 1) : undefined;
    if (cursor) params.set("cursor", `${cursor.ts}:${cursor.id}`);
    const key = `${version()}:${params}`;
    const found = cache.get(key);
    if (found?.scope === scope()) return found.promise;
    if (found) { found.abort.abort(); cache.delete(key); }
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    const abort = new AbortController();
    const entry = { scope: scope(), abort, promise: undefined as unknown as Promise<Page<T>> };
    const selected = config.path === "/api/admin/models" ? params.get("selected_ids") : null;
    if (selected) params.delete("selected_ids");
    entry.promise = api<Record<string, unknown>>(selected ? "POST" : "GET", `${config.path}${selected ? "/query" : ""}?${params}`, selected ? { selected_ids: JSON.parse(selected) } : undefined, abort.signal).then((data) => {
      if (!Array.isArray(data[config.result]) || typeof data.total !== "number") throw new Error("Invalid list response");
      const rows = data[config.result] as T[];
      const last = rows.at(-1) as { ts?: number; id?: number } | undefined;
      if (config.cursor && entry.scope === scope() && typeof last?.ts === "number" && typeof last?.id === "number") {
        if (cursors.size >= 256) cursors.delete(cursors.keys().next().value!);
        cursors.set(offset + rows.length - 1, { ts: last.ts, id: last.id });
      }
      return { rows, total: data.total };
    }).catch((error) => { if (cache.get(key) === entry) cache.delete(key); throw error; });
    cache.set(key, entry);
    return entry.promise;
  };
  const source = createMemo(() => ({ scope: scope(), offset: mobile() || config.cards ? (page() - 1) * PAGE_SIZE : 0 }));
  const [records, { refetch }] = createResource(source, async (source) => ({ ...await load(source.offset, PAGE_SIZE), scope: source.scope }));
  const setSort = (next: Sort) => { if (JSON.stringify(next) !== JSON.stringify(sort())) setSortValue(next); if (config.storageKey) try { localStorage.setItem(config.storageKey, JSON.stringify({ sortModel: next })); } catch {} };
  const setSearch = (next: string) => {
    setSearchValue(next); clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setSettledSearch(next.trim()), 150);
  };
  const refresh = () => {
    for (const entry of cache.values()) entry.abort.abort();
    cache.clear();
    batch(() => { setVersion((value) => value + 1); const range = filters.range();
      if (range.preset === "all") filters.setRange({ ...range, to: Date.now() + 1 }); else void filters.refetch(); });
    void filters.refetchPage();
  };
  const retry = () => { cache.clear(); void refetch(); };
  onCleanup(() => { media.removeEventListener("change", resize); clearTimeout(searchTimer); for (const entry of cache.values()) entry.abort.abort(); });
  return { filters, config, search, setSearch, sort, setSort, query, page, setPage, records, mobile, refresh, retry,
    rows: () => records.error ? [] : records()?.rows ?? [], total: () => records.error ? 0 : records()?.total ?? 0,
    loading: () => records.loading || filters.pending() || search().trim() !== settledSearch(),
    refreshKey: scope,
    datasource: serverDatasource<T>((params) => load(params.startRow, params.endRow - params.startRow, params.sortModel)),
  };
}

type CatalogView = ReturnType<typeof createCatalog<any>>;
export function CatalogToolbar(props: { view: CatalogView; right?: JSX.Element }) {
  const view = props.view;
  let searchInput!: HTMLInputElement;
  const selectedSort = () => view.sort()[0] ? `${view.sort()[0]!.colId}:${view.sort()[0]!.sort}` : "";
  const sortOptions = createMemo(() => {
    const current = view.sort()[0];
    const custom = current && !view.config.sort.some((option) => option.value === selectedSort());
    return [
      { value: "", label: "Default order" },
      ...(custom ? [{ value: selectedSort(), label: `${current.colId.replace(/_/g, " ").replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase())} · ${current.sort === "asc" ? "Ascending" : "Descending"}` }] : []),
      ...view.config.sort,
    ];
  });
  return <div class="catalog-toolbar" aria-label={`${view.config.label} controls`}>
    <div class="catalog-tools">
      <div class="catalog-search">
        <Icon name={Icons.search} size={16} />
        <input ref={searchInput} type="search" maxLength={200} value={view.search()} onInput={(event) => view.setSearch(event.currentTarget.value)} placeholder={`Search ${view.config.label.toLowerCase()}…`} aria-label={`Search ${view.config.label.toLowerCase()}`} />
        <Show when={view.search()}><button type="button" class="analytics-icon-button" aria-label={`Clear ${view.config.label.toLowerCase()} search`} onClick={() => { view.setSearch(""); searchInput.focus({ preventScroll: true }); }}><Icon name={Icons.x} size={14} /></button></Show>
      </div>
      {props.right}
    </div>
    <AnalyticsToolbar filters={view.filters} label={view.config.label.toLowerCase()} dateLabel={view.config.result === "entries" ? undefined : "Created"} loading={view.loading()} align="end"
      leadingControl={<Select variant="toolbar" ariaLabel={`Sort ${view.config.label.toLowerCase()}`} menuTitle="Sort order"
        icon={view.sort()[0]?.sort === "asc" ? "lucide:arrow-up-narrow-wide" : "lucide:arrow-down-wide-narrow"}
        value={selectedSort()} triggerLabel={selectedSort() ? undefined : "Sort"} options={sortOptions()}
        onChange={(value) => { const [colId, sort] = value.split(":"); view.setSort(colId && sort ? [{ colId, sort }] : []); }} />}
    />
    <div class="catalog-result-count" role="status" aria-live="polite">{view.records.error ? "Results unavailable" : view.loading() ? "Updating results…" : `${fmtNum(view.total())} ${view.config.label.toLowerCase()}`}</div>
  </div>;
}

export function CatalogState(props: { view: CatalogView; children: JSX.Element }) {
  return <Show when={!props.view.records.error} fallback={<div class="catalog-notice" role="alert"><Icon name="lucide:circle-alert" size={20} /><p>Could not load {props.view.config.label.toLowerCase()}. Your filters are preserved.</p><button type="button" class="ui-button ui-button-secondary" onClick={props.view.retry}>Try again</button></div>}>
    <Show when={props.view.records()} fallback={<div class="catalog-notice" role="status"><Icon name="lucide:loader-circle" size={18} class="animate-spin motion-reduce:animate-none" />Loading {props.view.config.label.toLowerCase()}…</div>}><div class="catalog-results" aria-busy={props.view.loading()}>{props.children}</div></Show>
  </Show>;
}

export function CatalogPagination(props: { view: CatalogView }) {
  const view = props.view;
  const pages = () => Math.max(1, Math.ceil(view.total() / PAGE_SIZE));
  return <Show when={view.total() > PAGE_SIZE}><nav class="catalog-pagination" aria-label={`${view.config.label} pages`}>
    <button type="button" class="analytics-control" disabled={view.page() <= 1 || view.loading()} onClick={() => view.setPage((value) => Math.max(1, value - 1))}><Icon name="lucide:chevron-left" size={14} />Previous</button>
    <span>{view.page()} / {fmtNum(pages())}</span>
    <button type="button" class="analytics-control" disabled={view.page() >= pages() || view.loading()} onClick={() => view.setPage((value) => Math.min(pages(), value + 1))}>Next<Icon name={Icons.chevronRight} size={14} /></button>
  </nav></Show>;
}
