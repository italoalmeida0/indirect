import { createSignal, onMount, Show, For, createResource } from "solid-js";

import { api, currentSession, setSession, type PublicUser } from "../api";
import { PageTitle, navigate } from "../index";
import { usalItems } from "../motion";
import { renderGoogleButton } from "../google";
import {
  Badge, Btn, Card, IconBtn, CardHeader, Icon, Icons, Input, Modal, ModalField, ModalNotice, Segmented, Spinner, copyWithToast, fmtDate, setThemeMode, themeMode, toast,
} from "../ui";

function parseUa(ua?: string) {
  if (!ua) return null;
  if (ua.includes("Bun/")) return `Bun runtime · ${ua}`;
  if (ua.includes("Chrome") && !ua.includes("Edg")) return "Google Chrome";
  if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg")) return "Microsoft Edge";
  return ua;
}

export default function SettingsPage() {
  const me = () => currentSession()!.user;
  const [name, setName] = createSignal(me().name);
  const [busy, setBusy] = createSignal(false);

  // password section
  const [curPw, setCurPw] = createSignal("");
  const [newPw, setNewPw] = createSignal("");
  const [newPw2, setNewPw2] = createSignal("");

  // totp section
  const [totpSetup, setTotpSetup] = createSignal<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = createSignal("");
  const [disableTotpOpen, setDisableTotpOpen] = createSignal(false);
  const [totpDisableCode, setTotpDisableCode] = createSignal("");

  // google link
  let googleDiv: HTMLDivElement | undefined;
  const [googleClientId, setGoogleClientId] = createSignal<string | null>(null);

  // session naming
  const [namingJti, setNamingJti] = createSignal<string | null>(null);
  const [sessionLabel, setSessionLabel] = createSignal("");

  // sessions
  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    const j = await api<{ sessions: any[] }>("GET", "/api/me/sessions");
    return j.sessions;
  });

  const refreshMe = (user: PublicUser) => {
    setSession({ ...currentSession()!, user });
  };

  onMount(async () => {
    if (me().googleLinked) return;
    try {
      const cfg = await api<{ googleClientId: string | null }>("GET", "/api/auth/config");
      setGoogleClientId(cfg.googleClientId);
      if (cfg.googleClientId && googleDiv) {
        renderGoogleButton(googleDiv, cfg.googleClientId, async (idToken) => {
          try {
            await api("POST", "/api/me/google/link", { idToken });
            toast("Google account linked");
            await reloadMe();
          } catch (e) {
            toast(e instanceof Error ? e.message : "link failed", "err");
          }
        });
      }
    } catch {}
  });

  const reloadMe = async () => {
    const j = await api<{ user: PublicUser }>("GET", "/api/me");
    refreshMe(j.user);
  };

  const saveName = async () => {
    setBusy(true);
    try {
      const j = await api<{ user: PublicUser }>("PATCH", "/api/me", { name: name().trim() });
      refreshMe(j.user);
      toast("Profile updated");
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (newPw().length < 10) return toast("At least 10 characters", "err");
    if (newPw() !== newPw2()) return toast("Passwords do not match", "err");
    setBusy(true);
    try {
      await api("POST", "/api/me/password", {
        currentPassword: curPw() || undefined,
        newPassword: newPw(),
      });
      toast("Password updated");
      setCurPw("");
      setNewPw("");
      setNewPw2("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const startTotp = async () => {
    setBusy(true);
    try {
      const j = await api<{ secret: string; otpauthUri: string; qrDataUrl: string }>("POST", "/api/me/2fa/setup");
      setTotpSetup(j);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const enableTotp = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/me/2fa/enable", { code: totpCode() });
      toast("Two-factor authentication enabled");
      setTotpSetup(null);
      setTotpCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "invalid code", "err");
    } finally {
      setBusy(false);
    }
  };

  const disableTotp = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/me/2fa/disable", { code: totpDisableCode() });
      toast("Two-factor authentication disabled");
      setDisableTotpOpen(false);
      setTotpDisableCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "invalid code", "err");
    } finally {
      setBusy(false);
    }
  };

  const unlinkGoogle = async () => {
    setBusy(true);
    try {
      await api("DELETE", "/api/me/google/link");
      toast("Google account unlinked");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (jti: string) => {
    try {
      await api("DELETE", `/api/me/sessions/${jti}`);
      toast("Session revoked");
      refetchSessions();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const saveSessionLabel = async () => {
    const jti = namingJti();
    if (!jti) return;
    try {
      await api("PATCH", `/api/me/sessions/${jti}`, { label: sessionLabel().trim() });
      toast("Session named");
      setNamingJti(null);
      refetchSessions();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  return (
    <div>
      <PageTitle title="Settings" />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="Profile & Appearance" />
          <div class="px-5 pb-5 space-y-5">
            <div class="space-y-4">
              <div class="flex items-end gap-3">
                <div class="flex-1">
                  <Input label="Display name" value={name()} onInput={setName} />
                </div>
                <Btn onClick={saveName} disabled={busy() || !name().trim() || name() === me().name}>Save</Btn>
              </div>
              <div>
                <span class="block text-xs font-medium text-ink-300 mb-1">Email</span>
                <div class="text-sm text-ink-400 font-mono text-xs">{me().email}</div>
              </div>
            </div>

            <div class="pt-4 border-t border-line">
              <span class="block text-xs font-medium text-ink-300 mb-0.5">Appearance</span>
              <p class="text-xs text-ink-400 mb-3">Light, dark, or follow system automatically</p>
              <Segmented
                value={themeMode()}
                onChange={setThemeMode}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Password" subtitle={me().hasPassword ? undefined : "Set account password"} />
          <div class="px-5 pb-5 space-y-4">
            <Show when={me().hasPassword}>
              <Input label="Current password" type="password" value={curPw()} onInput={setCurPw} autocomplete="current-password" />
            </Show>
            <Input label="New password" type="password" value={newPw()} onInput={setNewPw} autocomplete="new-password" hint="At least 10 characters" />
            <Input label="Confirm new password" type="password" value={newPw2()} onInput={setNewPw2} autocomplete="new-password" />
            <div class="flex justify-end">
              <Btn onClick={savePassword} disabled={busy() || !newPw()}>Update password</Btn>
            </div>
          </div>
        </Card>

        <Card class="lg:col-span-2">
          <div class="p-5">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div class="space-y-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-semibold text-ink-100">Two-factor authentication</h3>
                    <p class="text-xs text-ink-400 mt-0.5">Authenticator app (TOTP)</p>
                  </div>
                  <Badge tone={me().totpEnabled ? "green" : "zinc"}>{me().totpEnabled ? "Enabled" : "Disabled"}</Badge>
                </div>

                <Show
                  when={me().totpEnabled}
                  fallback={
                    <div class="space-y-3">
                      <p class="text-xs text-ink-400">Add an extra layer of security using an authenticator app.</p>
                      <Btn variant="outline" onClick={startTotp} disabled={busy()}>
                        <Icon name={Icons.shield} /> Set up 2FA
                      </Btn>
                    </div>
                  }
                >
                  <div class="space-y-3">
                    <p class="text-xs text-ink-300">Your account requires a 6-digit code at sign-in.</p>
                    <Btn variant="ghost" class="text-rose-400 bg-rose-500/10 hover:bg-rose-500/20" onClick={() => setDisableTotpOpen(true)}>
                      Disable 2FA
                    </Btn>
                  </div>
                </Show>
              </div>

              <div class="space-y-4 pt-5 lg:pt-0 border-t lg:border-t-0 lg:border-l border-line lg:pl-6">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-semibold text-ink-100">Google account</h3>
                  </div>
                  <Badge tone={me().googleLinked ? "green" : "zinc"}>{me().googleLinked ? "Linked" : "Not linked"}</Badge>
                </div>

                <Show
                  when={me().googleLinked}
                  fallback={
                    <Show when={googleClientId()} fallback={<p class="text-xs text-ink-500">Google sign-in is not configured on this gateway.</p>}>
                      <p class="text-xs text-ink-400">Link any Google account to sign in with it — the email does not need to match:</p>
                      <div ref={googleDiv} class="inline-flex overflow-hidden rounded-full" />
                    </Show>
                  }
                >
                  <p class="text-sm text-ink-300">You can sign in using your Google account.</p>
                  <Btn variant="ghost" class="text-rose-500 bg-rose-500/10 hover:bg-rose-500/25" onClick={unlinkGoogle} disabled={busy()}>
                    Unlink Google
                  </Btn>
                </Show>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card class="mt-6">
        <CardHeader title="Active sessions" />
        <div class="px-5 pb-5">
          <ul class="divide-y divide-line" {...usalItems("fade-u", 40)}>
            <For each={sessions() ?? []}>
              {(s) => (
                <li class="py-3.5 flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <Show
                        when={namingJti() === s.jti}
                        fallback={
                          <div class="flex items-center gap-2">
                            <span class={`text-sm truncate font-medium ${s.current ? "text-brand-400" : "text-ink-200"}`}>
                              {s.label || "Unnamed device"}
                            </span>
                            <button
                              type="button"
                              class="text-ink-400 hover:text-ink-200 p-0.5 rounded hover:bg-elev cursor-pointer transition-colors"
                              title={s.label ? "Rename device" : "Name this device"}
                              onClick={() => { setNamingJti(s.jti); setSessionLabel(s.label ?? ""); }}
                            >
                              <Icon name={Icons.edit} size={13} />
                            </button>
                          </div>
                        }
                      >
                        <div class="flex items-center gap-1.5">
                          <input
                            value={sessionLabel()}
                            onInput={(e) => setSessionLabel(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveSessionLabel();
                              if (e.key === "Escape") setNamingJti(null);
                            }}
                            placeholder="e.g. My laptop"
                            class="rounded-lg border border-line bg-elev px-2.5 py-1 text-xs text-ink-100 w-44 focus:border-ink-500 focus:outline-none focus:ring-2 focus:ring-ink-500/10"
                          />
                          <Btn size="sm" onClick={saveSessionLabel}>Save</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setNamingJti(null)}>Cancel</Btn>
                        </div>
                      </Show>
                      {s.current ? <Badge tone="indigo">This session</Badge> : null}
                    </div>

                    <div class="text-[11px] text-ink-500 mt-1 space-x-1.5">
                      <span class="font-mono text-ink-400">{s.ip ?? "unknown ip"}</span>
                      <span>·</span>
                      <span>created {fmtDate(s.createdAt)}</span>
                      <span>·</span>
                      <span>last used {fmtDate(s.lastUsedAt)}</span>
                    </div>

                    <Show when={parseUa(s.ua)}>
                      <div class="text-[11px] text-ink-500 truncate max-w-md mt-0.5">{parseUa(s.ua)}</div>
                    </Show>
                  </div>

                  <div class="flex gap-1 shrink-0">
                    <Show when={!s.current}>
                      <IconBtn
                        icon={Icons.logout}
                        title="Revoke"
                        onClick={() => revokeSession(s.jti)}
                      />
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Card>

      {/* 2FA Setup Modal */}
      <Modal
        open={!!totpSetup()}
        onClose={() => { setTotpSetup(null); setTotpCode(""); }}
        title="Set up two-factor authentication"
        subtitle="Scan the QR code with your authenticator app (1Password, Google Authenticator, Aegis…)"
        footer={
          <>
            <Btn variant="ghost" onClick={() => { setTotpSetup(null); setTotpCode(""); }}>Cancel</Btn>
            <Btn onClick={enableTotp} disabled={busy() || totpCode().length !== 6}>
              {busy() ? <Spinner /> : "Enable 2FA"}
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <div class="p-4 rounded-xl border border-line bg-elev flex flex-col sm:flex-row gap-5 items-center sm:items-start">
            <div class="flex flex-col items-center shrink-0">
              <img
                src={totpSetup()?.qrDataUrl}
                alt="TOTP QR code"
                class="w-36 h-36 rounded-lg border border-line bg-white p-2 shrink-0 shadow-xs"
              />
              <span class="text-[11px] text-ink-500 mt-2">Scan with your app</span>
            </div>
            <div class="flex-1 w-full space-y-3.5 min-w-0">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-medium text-ink-300">Manual setup key</span>
                  <button
                    type="button"
                    class="p-1 rounded text-ink-400 hover:text-ink-100 hover:bg-elev cursor-pointer transition-colors"
                    title="Copy secret key"
                    onClick={() => copyWithToast(totpSetup()?.secret ?? "")}
                  >
                    <Icon name={Icons.copy} size={13} />
                  </button>
                </div>
                <div
                  onClick={() => copyWithToast(totpSetup()?.secret ?? "")}
                  class="rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-center cursor-pointer hover:border-brand-500/50 transition-colors group"
                  title="Click to copy secret key"
                >
                  <code class="text-[11px] sm:text-xs font-mono text-emerald-400 tracking-wider select-all block break-all">
                    {totpSetup()?.secret?.match(/.{1,4}/g)?.join(" ") ?? totpSetup()?.secret}
                  </code>
                </div>
              </div>

              <div>
                <span class="block text-xs font-medium text-ink-300 mb-1">Verification code</span>
                <input
                  type="text"
                  value={totpCode()}
                  onInput={(e) => setTotpCode(e.currentTarget.value.trim())}
                  placeholder="000 000"
                  autocomplete="one-time-code"
                  maxlength={6}
                  autofocus
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-center text-base tracking-widest font-mono text-ink-100 placeholder:text-ink-600 focus:border-brand-500 focus:outline-none transition-colors"
                />
                <span class="text-[11px] text-ink-500 mt-1 block text-center sm:text-left">
                  Enter the 6-digit code from your authenticator app
                </span>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={disableTotpOpen()}
        onClose={() => setDisableTotpOpen(false)}
        title="Disable two-factor authentication"
        subtitle="Confirm with your current 6-digit authenticator code before removing 2FA protection."
        width="max-w-md"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setDisableTotpOpen(false)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={disableTotp}
              disabled={busy() || totpDisableCode().length !== 6}
            >
              Disable 2FA
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalField
            label="Current 6-digit authenticator code"
            hint="Enter the numerical code from Google Authenticator, 1Password, or Authy."
          >
            <input
              type="text"
              value={totpDisableCode()}
              onInput={(e) => setTotpDisableCode(e.currentTarget.value.trim())}
              placeholder="123456"
              autocomplete="one-time-code"
              maxlength={6}
              class="w-full rounded-lg border border-line bg-ink-950/70 px-3.5 py-2.5 text-center text-lg tracking-widest font-mono text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
            />
          </ModalField>

          <ModalNotice tone="warn" title="Reduced account protection">
            Disabling 2FA removes the second security layer. Your account will only require a password or Google OAuth to sign in.
          </ModalNotice>
        </div>
      </Modal>
    </div>
  );
}

// keep the navigate import used (for future deep links)
void navigate;
