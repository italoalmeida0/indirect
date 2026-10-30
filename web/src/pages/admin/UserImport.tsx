import { createSignal, For, Show } from "solid-js";
import { api } from "../../api";
import { Badge, Btn, Card, ModalNotice, Select, toast } from "../../ui";

interface Preview {
  batchId: string; expiresAt: number; valid: boolean;
  rows: { row: number; email: string; name: string; role: string; planId: string | null; projectIds: string[]; managed: boolean; oidcSubject?: string | null; status: "create" | "existing" | "error"; errors: string[] }[];
  summary: { create: number; existing: number; errors: number };
}
export default function UserImport() {
  const [format, setFormat] = createSignal("csv");
  const [content, setContent] = createSignal("");
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [result, setResult] = createSignal<{ created: number; existing: number; replayed: boolean } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const invalidate = () => { setPreview(null); setResult(null); setError(""); };
  const inspect = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError(""); setResult(null); setPreview(null);
    try { setPreview(await api<Preview>("POST", "/api/admin/users/import/preview", { format: format(), content: content() })); }
    catch (e) { setError(e instanceof Error ? e.message : "Preview failed"); } finally { setBusy(false); }
  };
  const commit = async () => {
    const batch = preview(); if (!batch) return; setBusy(true); setError("");
    try { const outcome = await api<{ created: number; existing: number; replayed: boolean }>("POST", "/api/admin/users/import/commit", { batchId: batch.batchId }); setResult(outcome); setPreview(null); toast("User import completed"); }
    catch (e) { setError(e instanceof Error ? e.message : "Import failed"); } finally { setBusy(false); }
  };
  return <div class="space-y-4"><Card class="p-4 sm:p-5 space-y-4"><h2 class="font-semibold text-ink-100">Bulk user import</h2><p class="text-sm text-ink-400">Preview up to 500 rows and 256 KiB. Existing email addresses are skipped without changing their accounts. A valid batch is committed atomically.</p><form onSubmit={inspect} class="space-y-4"><Select label="Import format" value={format()} onChange={(value) => { setFormat(value); invalidate(); }} options={[{ value: "csv", label: "CSV" }, { value: "json", label: "JSON array" }]} /><label class="block text-xs font-medium text-ink-300">User import content<textarea class="ui-field w-full min-h-52 font-mono text-xs mt-2" value={content()} onInput={(e) => { setContent(e.currentTarget.value); invalidate(); }} maxLength={262144} required spellcheck={false} placeholder={format() === "csv" ? "email,name,role,planId,projectIds,managed\nalex@example.com,Alex,user,,,false" : '[{"email":"alex@example.com","name":"Alex","role":"user"}]'} /></label><p class="text-xs text-ink-400">Columns: email, name, role (user, project_manager, admin), planId, projectIds (semicolon-separated in CSV), managed (true/false), oidcSubject (optional provider subject). IDs must already exist. Managed accounts require an explicit corporate subject when SSO is enforced.</p><Btn type="submit" disabled={busy() || !content().trim()}>{busy() ? "Processing…" : "Preview import"}</Btn></form><ModalNotice>No invitations or notifications are sent by import. After creating local users, use the user's invitation action explicitly. Corporate identities must be linked explicitly before managed users sign in.</ModalNotice></Card>
    <Show when={error()}><p role="alert" class="text-sm">{error()}</p></Show>
    <Show when={preview()}>{(batch) => <Card class="p-4 space-y-4"><h3 class="font-semibold text-sm">Import preview</h3><p class="text-sm text-ink-300">{batch().summary.create} new · {batch().summary.existing} existing · {batch().summary.errors} error(s)</p><p class="text-xs text-ink-400">Preview expires {new Date(batch().expiresAt).toLocaleString()}.</p><ol class="max-h-96 overflow-y-auto divide-y divide-line"><For each={batch().rows}>{(row) => <li class="py-3 space-y-1"><div class="flex flex-wrap gap-2 text-sm"><span class="text-ink-400">Row {row.row}</span><span class="break-all">{row.email || "Missing email"}</span><Badge tone={row.status === "error" ? "red" : row.status === "create" ? "green" : "zinc"}>{row.status}</Badge></div><p class="text-xs text-ink-400 break-words">{row.name} · {row.role}{row.managed ? " · managed" : ""}</p><For each={row.errors}>{(error) => <p class="text-xs text-ink-300" role="alert">{error}</p>}</For></li>}</For></ol><Btn disabled={busy() || !batch().valid || batch().summary.errors > 0} onClick={commit}>Commit {batch().summary.create} new users</Btn></Card>}</Show>
    <Show when={result()}>{(outcome) => <Card class="p-4"><p role="status" class="text-sm">Import complete: {outcome().created} created, {outcome().existing} existing accounts skipped.{outcome().replayed ? " This batch was already committed." : ""}</p></Card>}</Show>
  </div>;
}
