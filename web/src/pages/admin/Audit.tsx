import { For, Show, createResource } from "solid-js";

import { api } from "../../api";
import { PageTitle } from "../../index";
import { Badge, Card, CardHeader, EmptyState, Icons, fmtNum } from "../../ui";
import { DateTimeFilter, DateTimeFloatingFilter, UsageGrid, serverDatasource, timeFormatter } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  target?: string;
  meta?: string;
  ip?: string;
  actor_email?: string;
}

function humanAction(a: string): { label: string; tone: "green" | "red" | "zinc" | "indigo" | "amber" } {
  const map: Record<string, { label: string; tone: "green" | "red" | "zinc" | "indigo" | "amber" }> = {
    "key.create": { label: "Create key", tone: "green" },
    "key.delete": { label: "Delete key", tone: "red" },
    "key.update": { label: "Update key", tone: "zinc" },
    "key.reveal": { label: "Reveal key", tone: "indigo" },
    "login.success": { label: "Sign in", tone: "green" },
    "login.failed": { label: "Failed sign in", tone: "red" },
    "user.create": { label: "Create user", tone: "green" },
    "user.delete": { label: "Delete user", tone: "red" },
    "user.update": { label: "Update user", tone: "zinc" },
    "user.invite": { label: "Invite user", tone: "indigo" },
    "password.reset": { label: "Password reset", tone: "amber" },
    "password.change": { label: "Password change", tone: "zinc" },
    "model.create": { label: "Create model", tone: "green" },
    "model.delete": { label: "Delete model", tone: "red" },
    "model.update": { label: "Update model", tone: "zinc" },
    "totp.enable": { label: "Enable 2FA", tone: "green" },
    "totp.disable": { label: "Disable 2FA", tone: "amber" },
    "session.revoke": { label: "Revoke session", tone: "red" },
  };
  if (map[a]) return map[a];
  const isBad = a.includes("failed") || a.includes("deleted") || a.includes("exhausted") || a.includes("revoked");
  const isGood = a.includes("success") || a.includes("created") || a.includes("enabled");
  return {
    label: a.replace(/[._]/g, " "),
    tone: isBad ? "red" : isGood ? "green" : "zinc",
  };
}

/** Human-readable action badge */
function ActionCell(props: { value?: string }) {
  const info = humanAction(props.value ?? "");
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

function formatMeta(meta?: string) {
  if (!meta) return <span class="text-ink-600">—</span>;
  try {
    const parsed = JSON.parse(meta);
    if (typeof parsed === "object" && parsed !== null) {
      const entries = Object.entries(parsed).filter(([_, v]) => v !== undefined && v !== "");
      if (entries.length === 0) return <span class="text-ink-600">—</span>;
      return (
        <div class="flex items-center gap-1.5 flex-wrap">
          <For each={entries}>
            {([k, v]) => (
              <span class="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-elev border border-line text-ink-300">
                <span class="text-ink-500">{k}:</span>
                <span class="font-mono text-ink-200 truncate max-w-[140px]">{String(v)}</span>
              </span>
            )}
          </For>
        </div>
      );
    }
  } catch {}
  return <span class="text-ink-500 truncate block">{meta}</span>;
}

export default function AdminAuditPage() {
  const [auditCount] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/admin/audit?limit=1");
    return j.total;
  });

  const [auditList] = createResource(async () => {
    try {
      const j = await api<{ entries: AuditEntry[] }>("GET", "/api/admin/audit?limit=50");
      return j.entries;
    } catch {
      return [];
    }
  });

  /** Keyset cursor datasource for desktop AG Grid */
  const auditDatasource = serverDatasource<AuditEntry>((() => {
    const cursors = new Map<string, Map<number, { ts: number; id: number }>>();
    return async (params) => {
      const ctx = JSON.stringify([params.sortModel, params.filterModel]);
      let ctxCursors = cursors.get(ctx);
      if (!ctxCursors) {
        ctxCursors = new Map();
        cursors.set(ctx, ctxCursors);
      }
      const qs = new URLSearchParams({
        limit: String(Math.min(params.endRow - params.startRow, 500)),
        offset: String(params.startRow),
      });
      if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
      if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
      const cursor = params.startRow > 0 ? ctxCursors.get(params.startRow - 1) : undefined;
      if (cursor) qs.set("cursor", `${cursor.ts}:${cursor.id}`);
      const j = await api<{ entries: AuditEntry[]; total: number }>("GET", `/api/admin/audit?${qs}`);
      const last = j.entries[j.entries.length - 1];
      if (last) {
        ctxCursors.set(params.startRow + j.entries.length - 1, { ts: last.ts, id: last.id });
      }
      return { rows: j.entries, total: j.total };
    };
  })());

  const cols: ColDef[] = [
    {
      field: "ts",
      headerName: "Time",
      width: 170,
      filter: DateTimeFilter,
      floatingFilterComponent: DateTimeFloatingFilter,
      valueFormatter: timeFormatter,
    },
    { field: "action", headerName: "Action", width: 170, cellRenderer: ActionCell },
    {
      field: "actor_email",
      headerName: "Actor",
      flex: 1,
      minWidth: 160,
      valueGetter: (p) => p.data?.actor_email ?? p.data?.target ?? "—",
    },
    {
      field: "target",
      headerName: "Target",
      width: 180,
      cellRenderer: (p: { value?: string }) => (
        <span class="font-mono text-[11px] text-ink-300">{p.value?.slice(0, 24) ?? "—"}</span>
      ),
    },
    {
      field: "ip",
      headerName: "IP",
      width: 120,
      valueFormatter: (p) => p.value ?? "—",
    },
    {
      field: "meta",
      headerName: "Detail",
      flex: 1.2,
      minWidth: 200,
      cellRenderer: (p: { value?: string }) => formatMeta(p.value),
    },
  ];

  return (
    <div>
      <PageTitle
        title="Audit log"
      />

      <Card>
        <CardHeader title={`${fmtNum(auditCount() ?? 0)} events`} />
        <Show
          when={(auditCount() ?? 0) > 0}
          fallback={<EmptyState icon={Icons.book} title="No audit entries" />}
        >
          {/* Desktop & Tablet AG Grid */}
          <div class="hidden md:block p-2">
            <UsageGrid
              columnDefs={cols}
              datasource={auditDatasource}
              cacheBlockSize={100}
              heightClass="h-[560px]"
              storageKey="llmgw-grid:admin.audit"
            />
          </div>

          {/* Touch / Mobile Card List */}
          <div class="md:hidden space-y-3 p-3">
            <For each={auditList() ?? []}>
              {(entry) => {
                const act = humanAction(entry.action);
                return (
                  <div class="p-4 rounded-xl border border-line bg-elev space-y-2.5 shadow-xs">
                    <div class="flex items-center justify-between gap-2">
                      <Badge tone={act.tone}>{act.label}</Badge>
                      <span class="text-[11px] text-ink-400 font-mono">{timeFormatter({ value: entry.ts })}</span>
                    </div>

                    <div class="text-xs space-y-1.5 pt-1">
                      <div class="flex justify-between items-center text-ink-300">
                        <span class="text-ink-500">Actor</span>
                        <span class="font-medium truncate max-w-[200px]">{entry.actor_email ?? entry.target ?? "—"}</span>
                      </div>
                      <Show when={entry.target && entry.target !== entry.actor_email}>
                        <div class="flex justify-between items-center text-ink-300">
                          <span class="text-ink-500">Target</span>
                          <span class="font-mono text-[11px] truncate max-w-[200px]">{entry.target}</span>
                        </div>
                      </Show>
                      <Show when={entry.ip}>
                        <div class="flex justify-between items-center text-ink-400 text-[11px]">
                          <span class="text-ink-500">IP</span>
                          <span class="font-mono">{entry.ip}</span>
                        </div>
                      </Show>
                    </div>

                    <Show when={entry.meta}>
                      <div class="pt-2 border-t border-line/60">
                        {formatMeta(entry.meta)}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Card>
    </div>
  );
}
