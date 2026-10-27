import { Show, createEffect, onCleanup } from "solid-js";
import AgGridSolid, { type AgGridSolidRef } from "solid-ag-grid";
import type { ColDef, ColGroupDef, GridApi } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import { Badge, fmtCost, fmtDate, fmtNum, getTheme, theme } from "./ui";

/** OpenAI / Anthropic protocol badge cell. */
export function ProtoCell(props: { value?: string }) {
  const openai = props.value === "openai";
  return (
    <Badge tone={openai ? "indigo" : "amber"}>
      {openai ? "OpenAI" : "Anthropic"}
    </Badge>
  );
}

/** HTTP-status badge cell. */
export function StatusCell(props: { value?: number }) {
  const s = Number(props.value ?? 0);
  return (
    <Badge tone={s < 400 ? "green" : s < 500 ? "amber" : "red"}>{s}</Badge>
  );
}

/** Token-bucket numeric cell formatter (compact "1.2M"). */
export function tokenFormatter(p: { value?: unknown }) {
  return fmtNum(Number(p.value ?? 0));
}

/** Epoch-ms timestamp cell formatter. */
export function timeFormatter(p: { value?: unknown }) {
  return fmtDate(Number(p.value ?? 0));
}

/** Latency cell formatter ("1234 ms"). */
export function latencyFormatter(p: { value?: unknown }) {
  return `${fmtNum(Number(p.value ?? 0))}ms`;
}

/** Cost numeric cell formatter ("$0.0042", "$12.34"). */
export function costFormatter(p: { value?: unknown }) {
  if (p.value == null || p.value === "") return "—";
  return fmtCost(Number(p.value));
}

export interface GridRowsParams {
  startRow: number;
  endRow: number;
  sortModel: Array<{ colId: string; sort: string }>;
  filterModel: Record<string, unknown>;
  successCallback: (rowsThisBlock: unknown[], lastRow: number) => void;
  failCallback: () => void;
}

export function serverDatasource<T>(
  load: (params: {
    startRow: number;
    endRow: number;
    sortModel: Array<{ colId: string; sort: string }>;
    filterModel: Record<string, unknown>;
  }) => Promise<{ rows: T[]; total: number }>,
) {
  return {
    getRows: async (params: GridRowsParams) => {
      try {
        const result = await load({
          startRow: params.startRow,
          endRow: params.endRow,
          sortModel: params.sortModel,
          filterModel: params.filterModel,
        });
        params.successCallback(result.rows, result.total);
      } catch {
        params.failCallback();
      }
    },
  };
}

const DEFAULT_COL_DEF: ColDef = { sortable: true, resizable: false, filter: false, floatingFilter: false, suppressMovable: true, suppressMenu: true, lockVisible: true, minWidth: 72, maxWidth: 640 };
const PAGE_SIZE_SELECTOR = [15, 25, 50, 100];
const plainColumn = (column: ColDef | ColGroupDef): ColDef | ColGroupDef => "children" in column
  ? { ...column, marryChildren: true, children: column.children.map(plainColumn) }
  : { ...column, resizable: false, suppressMovable: true, lockVisible: true, filter: false, floatingFilter: false, floatingFilterComponent: undefined, suppressMenu: true };
const leaves = (columns: Array<ColDef | ColGroupDef>): ColDef[] => columns.flatMap((column) => "children" in column ? leaves(column.children) : [column]);

/** A fixed-order table: external filters own the scope; headers only sort.
 * Content widths grow as blocks arrive. Old layout/filter preferences are
 * deliberately discarded; only validated sort state survives. */
export function UsageGrid(props: {
  columnDefs: Array<ColDef | ColGroupDef>;
  rowData?: unknown[];
  pageSize?: number;
  heightClass?: string;
  storageKey: string;
  rowSelection?: "single" | "multiple";
  suppressRowClickSelection?: boolean;
  getRowId?: (p: { data: any }) => string;
  onSelectionChanged?: (event: any) => void;
  onGridReady?: (event: any) => void;
  onGridDestroyed?: () => void;
  onModelUpdated?: (event: any) => void;
  onSortChanged?: (sort: Array<{ colId: string; sort: string }>) => void;
  sort?: Array<{ colId: string; sort: string }>;
  datasource?: { getRows: (params: GridRowsParams) => void };
  cacheBlockSize?: number;
  refreshDeps?: unknown;
}) {
  const columns = props.columnDefs.map(plainColumn);
  const original = leaves(props.columnDefs);
  const allowedSort = new Set(original.filter((column) => column.sortable !== false).map((column) => column.colId ?? column.field ?? ""));
  const contentColumns = new Set(original.filter((column) => column.resizable !== false && !column.checkboxSelection && !column.headerCheckboxSelection && (column.field || column.colId) && column.headerName).map((column) => column.colId ?? column.field!));
  const widths = new Map<string, number>();
  let gridRef: AgGridSolidRef | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const darkClass = () => { theme(); return getTheme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz"; };
  const sortState = (api: GridApi) => api.getColumnState().filter((column) => column.sort).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)).map((column) => ({ colId: column.colId, sort: column.sort! }));
  const saveSort = (api: GridApi) => {
    const sort = sortState(api);
    try { localStorage.setItem(props.storageKey, JSON.stringify({ sortModel: sort })); } catch {}
    props.onSortChanged?.(sort);
  };
  const applySort = (api: GridApi, sort: Array<{ colId: string; sort: string }>) => {
    if (JSON.stringify(sortState(api)) === JSON.stringify(sort)) return;
    api.applyColumnState({ state: sort.filter((column) => allowedSort.has(column.colId) && (column.sort === "asc" || column.sort === "desc")).map((column, index) => ({ colId: column.colId, sort: column.sort as "asc" | "desc", sortIndex: index })), defaultState: { sort: null, sortIndex: null } });
  };
  createEffect(() => { const sort = props.sort; if (sort && gridRef?.api && !gridRef.api.isDestroyed()) applySort(gridRef.api, sort); });
  const autoSize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const api = gridRef?.api;
      if (!api || api.isDestroyed() || !api.getDisplayedRowCount()) return;
      const ids = api.getAllDisplayedColumns().filter((column) => contentColumns.has(column.getColId())).map((column) => column.getColId());
      api.autoSizeColumns(ids, false);
      const grow = ids.map((id) => {
        const width = Math.max(widths.get(id) ?? 0, api.getColumn(id)?.getActualWidth() ?? 72);
        widths.set(id, width); return { key: id, newWidth: width };
      });
      api.setColumnWidths(grow, true);
    }, 60);
  };
  createEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- reactive cache invalidation
    props.refreshDeps;
    gridRef?.api?.purgeInfiniteCache();
  });
  onCleanup(() => { clearTimeout(timer); props.onGridDestroyed?.(); });
  return <div class={`basic-grid w-full max-h-[72vh] ${darkClass()} ${props.heightClass ?? "h-[480px]"}`}>
    <Show when={props.rowData ?? props.datasource}><AgGridSolid ref={gridRef} columnDefs={columns} defaultColDef={DEFAULT_COL_DEF} rowData={props.rowData!}
      {...(props.datasource ? { rowModelType: "infinite" as const, datasource: props.datasource, cacheBlockSize: props.cacheBlockSize ?? 100, maxBlocksInCache: 8, maxConcurrentDatasourceRequests: 2, infiniteInitialRowCount: 1, blockLoadDebounceMillis: 50 }
        : { pagination: true, paginationPageSize: props.pageSize ?? 25, paginationPageSizeSelector: PAGE_SIZE_SELECTOR })}
      suppressMovableColumns suppressDragLeaveHidesColumns rowHeight={40} suppressCellFocus rowSelection={props.rowSelection} suppressRowClickSelection={props.suppressRowClickSelection} getRowId={props.getRowId} onSelectionChanged={props.onSelectionChanged}
      onGridReady={(event) => {
        try {
          const saved = JSON.parse(localStorage.getItem(props.storageKey) ?? "{}");
          const sort = (Array.isArray(saved.sortModel) ? saved.sortModel : Array.isArray(saved.columnState) ? saved.columnState : []).filter((column: any) => allowedSort.has(column.colId) && (column.sort === "asc" || column.sort === "desc"));
          applySort(event.api, props.sort ?? sort);
        } catch {}
        saveSort(event.api); props.onGridReady?.(event); autoSize();
      }}
      onFirstDataRendered={autoSize} onModelUpdated={(event) => { autoSize(); props.onModelUpdated?.(event); }} onSortChanged={(event) => saveSort(event.api)}
    /></Show>
  </div>;
}
