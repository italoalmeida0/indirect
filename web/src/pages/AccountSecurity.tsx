import { createResource, createSignal, For, Show } from "solid-js";
import { api, currentSession, setSession } from "../api";
import { Badge, Btn, Card, Input, Modal, ModalNotice, copyWithToast, toast } from "../ui";

interface Security { managed: boolean; ssoExempt: boolean; oidcLinked: boolean; requireAdminMfa: boolean; recoveryCodesRemaining: number }
export default function AccountSecurity() {
  const [security, { refetch }] = createResource(async () => api<Security>("GET", "/api/me/security"));
  const readSecurity = () => security.error ? undefined : security();
  const [config] = createResource(async () => api<{ oidcEnabled?: boolean }>("GET", "/api/auth/config"));
  const readConfig = () => config.error ? undefined : config();
  const [action, setAction] = createSignal<"link" | "unlink" | "recovery" | null>(null);
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [codes, setCodes] = createSignal<string[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const open = (kind: "link" | "unlink" | "recovery") => { setAction(kind); setPassword(""); setCode(""); setCodes([]); setError(""); };
  const close = () => { if (!busy()) { setAction(null); setPassword(""); setCode(""); setCodes([]); } };
  const submit = async (event: Event) => {
    event.preventDefault(); const kind = action(); if (!kind) return; setBusy(true); setError("");
    try {
      if (kind === "recovery") {
        const result = await api<{ codes: string[] }>("POST", "/api/me/security/recovery-codes", { code: code().trim() });
        setCodes(result.codes); setCode(""); await refetch();
      } else {
        const result = await api<{ authorizationUrl?: string; signedOut?: boolean }>(kind === "link" ? "POST" : "DELETE", "/api/me/oidc/link", { password: password(), ...(code().trim() ? { code: code().trim() } : {}) });
        setPassword(""); setCode("");
        if (kind === "link" && result.authorizationUrl) location.assign(result.authorizationUrl);
        else { setAction(null); if (result.signedOut) { setSession(null); location.hash = "/login"; } else await refetch(); toast("Corporate identity unlinked. Sign in again to continue."); }
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Security action failed"); } finally { setBusy(false); }
  };
  return <Card class="mt-6 p-5 space-y-4"><h2 class="text-sm font-semibold text-ink-100">Corporate identity and recovery</h2><Show when={security.error}><p role="alert" class="text-xs text-ink-400">Security settings could not be loaded.</p><Btn size="sm" variant="outline" onClick={() => refetch()}>Retry security settings</Btn></Show><Show when={readSecurity()}>{(details) => <>
    <Show when={details().requireAdminMfa && currentSession()?.user.role === "admin"}><ModalNotice>Administrator MFA is required by this installation.</ModalNotice></Show>
    <Show when={readConfig()?.oidcEnabled || details().oidcLinked}><div class="flex flex-wrap justify-between gap-3 items-center"><div><p class="text-sm"><Badge tone={details().oidcLinked ? "green" : "zinc"}>{details().oidcLinked ? "Corporate identity linked" : "Corporate identity not linked"}</Badge></p><p class="text-xs text-ink-400 mt-2">{details().managed ? "Managed corporate account" : "Local account"}{details().ssoExempt ? " · SSO recovery exemption" : ""}</p></div><Show when={currentSession()?.user.hasPassword}><Btn size="sm" variant="outline" onClick={() => open(details().oidcLinked ? "unlink" : "link")}>{details().oidcLinked ? "Unlink corporate identity" : "Link corporate identity"}</Btn></Show></div></Show>
    <Show when={currentSession()?.user.totpEnabled}><div class="flex flex-wrap justify-between gap-3 items-center border-t border-line pt-4"><p class="text-xs text-ink-400">{details().recoveryCodesRemaining} recovery codes remain. Each code works once.</p><Btn variant="outline" size="sm" onClick={() => open("recovery")}>Generate recovery codes</Btn></div></Show>
    <Show when={!readConfig()?.oidcEnabled && !details().oidcLinked && !currentSession()?.user.totpEnabled}><p class="text-xs text-ink-400">Enable two-factor authentication to generate recovery codes. Corporate sign-in is optional and configured by your administrator.</p></Show>
  </>}</Show>
  <Modal open={action() !== null} onClose={close} title={codes().length ? "Save your recovery codes" : action() === "recovery" ? "Generate recovery codes" : action() === "unlink" ? "Unlink corporate identity" : "Link corporate identity"}>
    <Show when={codes().length} fallback={<form onSubmit={submit} class="space-y-4"><Show when={action() !== "recovery"}><Input label="Confirm account password" type="password" value={password()} onInput={setPassword} autocomplete="current-password" required /></Show><Show when={action() === "recovery" || currentSession()?.user.totpEnabled}><Input label="Current authenticator code" value={code()} onInput={setCode} autocomplete="one-time-code" required /></Show><ModalNotice tone="warn">{action() === "recovery" ? "Generating codes invalidates the old set and revokes your other sessions. Store the new codes safely; they are shown once." : action() === "link" ? "Continue to your corporate provider to confirm the identity you want to link." : "Your administrator's SSO policy may require a linked corporate identity to sign in."}</ModalNotice><Show when={error()}><p role="alert" class="text-sm">{error()}</p></Show><div class="flex flex-wrap justify-end gap-2"><Btn variant="ghost" disabled={busy()} onClick={close}>Cancel</Btn><Btn type="submit" disabled={busy()}>{busy() ? "Working…" : action() === "recovery" ? "Generate codes" : "Continue"}</Btn></div></form>}>
      <div class="space-y-4"><ModalNotice tone="warn">Save these codes now. They cannot be retrieved after closing this dialog.</ModalNotice><ul class="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-sm select-all"><For each={codes()}>{(value) => <li class="rounded-lg bg-elev border border-line p-2 break-all">{value}</li>}</For></ul><div class="flex flex-wrap gap-2 justify-end"><Btn variant="outline" onClick={() => copyWithToast(codes().join("\n"))}>Copy recovery codes</Btn><Btn onClick={close}>I saved my codes</Btn></div></div>
    </Show>
  </Modal></Card>;
}
