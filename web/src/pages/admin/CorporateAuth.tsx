import { createEffect, createResource, createSignal, Show } from "solid-js";
import { api, setSession } from "../../api";
import { Badge, Btn, Card, Input, ModalNotice, SwitchCard, toast } from "../../ui";

const failure = (error: unknown) => error instanceof Error ? error.message : "Request failed";
interface CorporateConfig {
  enabled: boolean; issuer: string; clientId: string; clientSecretSet: boolean;
  requireManagedSso: boolean; requireAdminMfa: boolean; version: number; callbackUrl: string;
}

export default function CorporateAuth() {
  const [data, { refetch }] = createResource(async () => api<{ config: CorporateConfig; readiness: { localRecoveryAdmins: number; adminsWithoutMfa: number } }>("GET", "/api/admin/corporate-auth"));
  const readData = () => data.error ? undefined : data();
  const [enabled, setEnabled] = createSignal(false);
  const [issuer, setIssuer] = createSignal("");
  const [clientId, setClientId] = createSignal("");
  const [secret, setSecret] = createSignal("");
  const [sso, setSso] = createSignal(false);
  const [mfa, setMfa] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => { const config = readData()?.config; if (config) { setEnabled(config.enabled); setIssuer(config.issuer); setClientId(config.clientId); setSso(config.requireManagedSso); setMfa(config.requireAdminMfa); setSecret(""); } });
  const save = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ signedOut?: boolean }>("PUT", "/api/admin/corporate-auth", { enabled: enabled(), issuer: issuer().trim(), clientId: clientId().trim(), ...(secret() ? { clientSecret: secret() } : {}), requireManagedSso: sso(), requireAdminMfa: mfa() }); setSecret(""); if (result.signedOut) { setSession(null); location.hash = "/login"; } else await refetch(); toast("Corporate authentication saved. Sign in again to continue."); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <Card class="p-4 sm:p-5 space-y-4"><h2 class="font-semibold text-ink-100">Corporate authentication</h2><p class="text-sm text-ink-400">Optional OpenID Connect. Local sign-in stays available when policies are disabled. Link an identity explicitly in Users or from the user's own security settings.</p>
    <Show when={data.error}><p role="alert">{failure(data.error)}</p><Btn size="sm" variant="outline" onClick={() => refetch()}>Retry corporate authentication</Btn></Show><Show when={readData()}>{(details) => <form onSubmit={save} class="space-y-4">
      <SwitchCard title="Enable corporate sign-in" checked={enabled()} onChange={setEnabled} />
      <Input label="OIDC issuer URL" type="url" value={issuer()} onInput={setIssuer} required={enabled()} hint="Use the exact issuer URL published by your identity provider." /><Input label="OIDC client ID" value={clientId()} onInput={setClientId} required={enabled()} /><Input label="OIDC client secret" type="password" value={secret()} onInput={setSecret} autocomplete="new-password" hint={details().config.clientSecretSet ? "A secret is configured. Leave empty to retain it." : "No client secret configured."} />
      <div class="rounded-lg border border-line bg-elev p-3"><p class="text-xs text-ink-400">Register this callback URL with the provider</p><p class="font-mono text-xs break-all mt-1 select-all">{details().config.callbackUrl}</p></div>
      <SwitchCard title="Require SSO for managed accounts" checked={sso()} onChange={setSso} description="Managed users must use their explicitly linked corporate identity. Sessions are revalidated when policies change." /><SwitchCard title="Require MFA for administrators" checked={mfa()} onChange={setMfa} description="Enroll every active administrator in two-factor authentication before enabling this policy." />
      <p class="text-xs text-ink-400">Saving authentication policy signs all users out, including you. Their next sign-in uses the new policy.</p>
      <ModalNotice title="Recovery readiness"><p>{details().readiness.localRecoveryAdmins} local recovery administrator(s). {details().readiness.adminsWithoutMfa} administrator(s) without MFA.</p><p class="mt-2">Required SSO needs an active local administrator with a password, MFA, and an explicit SSO exemption. Keep recovery codes stored safely before changing identity policies.</p></ModalNotice>
      <Show when={error()}><p role="alert" class="text-sm">{error()}</p></Show><Btn type="submit" disabled={busy()}>{busy() ? "Saving…" : "Save authentication policy"}</Btn>
    </form>}</Show>
  </Card>;
}

export function UserCorporatePolicy(props: { userId: string }) {
  interface Policy { managed: boolean; ssoExempt: boolean; linked: boolean; issuer: string | null; subject: string | null }
  const [data, { refetch }] = createResource(() => props.userId, async (id) => (await api<{ policy: Policy }>("GET", `/api/admin/users/${encodeURIComponent(id)}/corporate-auth`)).policy);
  const readData = () => data.error ? undefined : data();
  const [managed, setManaged] = createSignal(false);
  const [exempt, setExempt] = createSignal(false);
  const [issuer, setIssuer] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  createEffect(() => { const policy = readData(); if (policy) { setManaged(policy.managed); setExempt(policy.ssoExempt); setIssuer(policy.issuer ?? ""); setSubject(policy.subject ?? ""); } });
  const save = async (event: Event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { const result = await api<{ signedOut?: boolean }>("PUT", `/api/admin/users/${encodeURIComponent(props.userId)}/corporate-auth`, { managed: managed(), ssoExempt: exempt(), ...(subject().trim() ? { issuer: issuer().trim(), subject: subject().trim() } : { subject: null }) }); if (result.signedOut) { setSession(null); location.hash = "/login"; } else await refetch(); toast("Corporate account policy saved; user sessions revoked"); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  };
  return <div class="space-y-4"><Show when={data.error}><p role="alert">{failure(data.error)}</p><Btn size="sm" variant="outline" onClick={() => refetch()}>Retry account access</Btn></Show><Show when={readData()}><form onSubmit={save} class="space-y-4"><Badge tone={readData()!.linked ? "green" : "zinc"}>{readData()!.linked ? "Corporate identity linked" : "No corporate identity"}</Badge><SwitchCard title="Managed corporate account" checked={managed()} onChange={setManaged} /><SwitchCard title="Local SSO recovery exemption" checked={exempt()} onChange={setExempt} description="Reserve for administrators who maintain local recovery access." /><Input label="Identity issuer" type="url" value={issuer()} onInput={setIssuer} /><Input label="Identity subject" value={subject()} onInput={setSubject} hint="Use the provider's immutable subject identifier, never an email guess. Clear both fields to unlink." /><ModalNotice tone="warn">Saving this policy revokes the user's active sessions. Confirm the issuer and subject with the identity provider before linking.</ModalNotice><Show when={error()}><p role="alert">{error()}</p></Show><Btn type="submit" disabled={busy()}>Save corporate account policy</Btn></form></Show></div>;
}
