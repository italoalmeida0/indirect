import { createResource, createSignal, For, Show } from "solid-js";
import { api } from "../../api";
import { Badge, Btn, Card, Modal, ModalNotice, fmtNum, toast } from "../../ui";

interface BackupSummary { id: string; kind: string; createdAt: number; bytes: number; schemaVersion: number; verified: boolean | null; error?: string }
interface BackupStatus { enabled: boolean; intervalMinutes: number; keepDaily: number; keepWeekly: number; count: number; totalBytes: number; lastAttemptAt: number | null; lastAttemptOk: boolean | null; dir: string }
interface Duration { count: number; p50: number; p95: number; p99: number; max: number }
interface Metrics {
  uptimeSeconds: number;
  http: { requests: number; active: number; completed: number; errors: number; routes: { route: string; requests: number; active: number; errors: number; durationMs: Duration }[] };
  admission: Record<string, unknown>;
  analytics: { workers: number; active: number; queued: number; pendingLimit: number; completed: number; failed: number; timedOut: number };
  maintenance: { name: string; running: boolean; runs: number; failures: number; lastSuccessAt: number | null; lastDurationMs: number | null; lastError: string | null }[];
  storage: { busyRetries: number; busyFailures: number; checkpoints: { runs: number; busyRuns: number; lastRunAt: number | null; lastLogFrames: number; lastCheckpointedFrames: number } };
  retention: { runs: number; totalDeleted: number; lastDeleted: number; lastRawFrom: number; lastRemaining: boolean };
}
const failure = (error: unknown) => error instanceof Error ? error.message : "Request failed";
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;

export default function Operations() {
  const [metrics, { refetch: refreshMetrics }] = createResource(async () => (await api<{ metrics: Metrics }>("GET", "/api/admin/metrics")).metrics);
  const readMetrics = () => metrics.error ? undefined : metrics();
  const [backups, { refetch: refreshBackups }] = createResource(async () => api<{ backups: BackupSummary[]; status: BackupStatus }>("GET", "/api/admin/backups"));
  const readBackups = () => backups.error ? undefined : backups();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [deleting, setDeleting] = createSignal<BackupSummary | null>(null);
  const backupAction = async (method: string, path: string) => {
    setBusy(true); setError("");
    try {
      const result = await api<{ verification?: { ok: boolean; error?: string }; backup?: { verification?: { ok: boolean; error?: string } } }>(method, path);
      const verification = result.verification ?? result.backup?.verification;
      if (verification && !verification.ok) throw new Error(verification.error ?? "Backup verification failed");
      setDeleting(null); toast(method === "DELETE" ? "Backup deleted" : verification ? "Backup verified" : "Backup completed");
      await refreshBackups();
    } catch (e) { setError(failure(e)); await refreshBackups(); } finally { setBusy(false); }
  };
  return <div class="space-y-5"><Card class="p-4 sm:p-5 space-y-4"><div class="flex flex-wrap justify-between items-center gap-3"><div><h2 class="font-semibold text-ink-100">Operational metrics</h2><p class="text-xs text-ink-400 mt-1">Process counters since startup. Quantiles cover the last 512 completions per route family, including stream consumption; they describe serving duration and do not measure gateway overhead separately.</p></div><Btn size="sm" variant="outline" disabled={metrics.loading} onClick={() => refreshMetrics()}>Refresh metrics</Btn></div>
    <Show when={metrics.error}><p role="alert">{failure(metrics.error)}</p></Show><Show when={readMetrics()}>{(data) => <>
      <dl class="grid grid-cols-2 sm:grid-cols-4 gap-4"><For each={[{ name: "Requests", value: data().http.requests }, { name: "Active requests", value: data().http.active }, { name: "Errors", value: data().http.errors }, { name: "Uptime (seconds)", value: Math.floor(data().uptimeSeconds) }]}>{(stat) => <div><dt class="text-xs text-ink-400">{stat.name}</dt><dd class="font-mono mt-1">{fmtNum(stat.value)}</dd></div>}</For></dl>
      <div class="space-y-2"><For each={data().http.routes}>{(route) => <div class="p-3 rounded-lg border border-line text-xs"><div class="flex flex-wrap justify-between gap-2"><span class="font-medium break-all">{route.route}</span><span class="text-ink-400">{route.requests} requests · {route.errors} errors · {route.active} active</span></div><p class="font-mono mt-2 text-ink-300">p50 {route.durationMs.p50.toFixed(1)} ms · p95 {route.durationMs.p95.toFixed(1)} ms · p99 {route.durationMs.p99.toFixed(1)} ms · max {route.durationMs.max.toFixed(1)} ms</p></div>}</For></div>
      <div class="grid gap-4 sm:grid-cols-2"><div><h3 class="text-sm font-medium">Analytics workers</h3><p class="text-xs text-ink-400 mt-2">{data().analytics.workers} workers · {data().analytics.active} active · {data().analytics.queued}/{data().analytics.pendingLimit} queued</p><p class="text-xs text-ink-400 mt-1">{data().analytics.failed} failures · {data().analytics.timedOut} timeouts</p></div><div><h3 class="text-sm font-medium">SQLite</h3><p class="text-xs text-ink-400 mt-2">{data().storage.busyRetries} busy retries · {data().storage.busyFailures} busy failures · {data().storage.checkpoints.runs} checkpoints ({data().storage.checkpoints.busyRuns} busy)</p></div></div>
      <p class="text-xs text-ink-400">Retention: {data().retention.totalDeleted} detailed rows removed across {data().retention.runs} runs. {data().retention.lastRemaining ? "A backlog remains for the next bounded run." : "No backlog reported by the last run."}</p>
      <details class="rounded-lg border border-line p-3"><summary class="text-xs text-ink-300 cursor-pointer">Admission and checkpoint details</summary><pre class="text-[11px] text-ink-400 mt-3 whitespace-pre-wrap break-all">{JSON.stringify({ admission: data().admission, checkpoints: data().storage.checkpoints }, null, 2)}</pre></details>
      <h3 class="font-medium text-sm">Maintenance</h3><For each={data().maintenance}>{(job) => <div class="flex flex-wrap justify-between gap-2 border-t border-line py-2 text-xs"><span>{job.name} <Badge tone={job.running ? "amber" : job.failures ? "red" : "green"}>{job.running ? "Running" : `${job.runs} runs`}</Badge></span><span class="text-ink-400">{job.failures} failures · last {job.lastDurationMs == null ? "—" : `${job.lastDurationMs.toFixed(1)} ms`}{job.lastSuccessAt ? ` · success ${new Date(job.lastSuccessAt).toLocaleString()}` : ""}</span><Show when={job.lastError}><p role="alert" class="w-full break-words">{job.lastError}</p></Show></div>}</For>
    </>}</Show>
  </Card>
  <Card class="p-4 sm:p-5 space-y-4"><div class="flex flex-wrap justify-between gap-3"><div><h2 class="font-semibold text-ink-100">Backups</h2><p class="text-xs text-ink-400 mt-1">Consistent snapshots are verified before they are considered usable.</p></div><div class="flex gap-2"><Btn size="sm" variant="outline" disabled={backups.loading || busy()} onClick={() => refreshBackups()}>Refresh backups</Btn><Btn size="sm" disabled={busy()} onClick={() => backupAction("POST", "/api/admin/backups")}>{busy() ? "Working…" : "Create verified backup"}</Btn></div></div>
    <Show when={backups.error}><p role="alert">{failure(backups.error)}</p></Show><Show when={readBackups()}>{(data) => <><p class="text-xs text-ink-400">{data().status.enabled ? `Scheduled every ${data().status.intervalMinutes} minutes` : "Scheduled backups disabled"} · retain {data().status.keepDaily} daily / {data().status.keepWeekly} weekly · {bytes(data().status.totalBytes)}</p><p class="text-xs text-ink-400 break-all">Snapshot directory: {data().status.dir}</p><Show when={data().status.lastAttemptOk === false}><ModalNotice tone="warn">The last backup attempt failed. Inspect the server logs and create a fresh verified snapshot.</ModalNotice></Show><Show when={!data().backups.length}><p class="text-sm text-ink-400">No backups yet.</p></Show><For each={data().backups}>{(backup) => <div class="border-t border-line pt-3 flex flex-wrap justify-between items-start gap-3"><div class="min-w-0"><p class="text-sm font-medium break-all">{backup.id}</p><p class="text-xs text-ink-400 mt-1">{new Date(backup.createdAt).toLocaleString()} · {bytes(backup.bytes)} · schema {backup.schemaVersion}</p><Badge tone={backup.verified === true ? "green" : backup.verified === false ? "red" : "amber"}>{backup.verified === true ? "Verified" : backup.verified === false ? "Verification failed" : "Unverified"}</Badge><Show when={backup.error}><p class="text-xs mt-1 break-words">{backup.error}</p></Show></div><div class="flex flex-wrap gap-2"><Btn variant="outline" size="sm" disabled={busy()} onClick={() => backupAction("POST", `/api/admin/backups/${encodeURIComponent(backup.id)}/verify`)}>Verify {backup.id}</Btn><Btn variant="ghost" size="sm" disabled={busy()} onClick={() => setDeleting(backup)}>Delete {backup.id}</Btn></div></div>}</For></>}</Show>
    <Show when={error() && !deleting()}><p role="alert" class="text-sm">{error()}</p></Show><ModalNotice title="Restore into an empty installation">Restore uses the documented offline CLI flow so an active installation cannot be overwritten from the dashboard. Protect the backup directory: snapshots contain encrypted credentials and the secret material required to restore them. See the operating guide at <code>docs/gateway-enterprise.md</code>.</ModalNotice>
  </Card>
  <Modal open={!!deleting()} onClose={() => !busy() && setDeleting(null)} title="Delete backup"><p class="text-sm mb-4 break-all">Permanently delete snapshot {deleting()?.id}?</p><Show when={error()}><p role="alert" class="text-sm mb-3">{error()}</p></Show><div class="flex flex-wrap justify-end gap-2"><Btn variant="ghost" disabled={busy()} onClick={() => setDeleting(null)}>Cancel</Btn><Btn variant="danger" disabled={busy()} onClick={() => backupAction("DELETE", `/api/admin/backups/${encodeURIComponent(deleting()!.id)}`)}>Delete snapshot</Btn></div></Modal>
  </div>;
}
