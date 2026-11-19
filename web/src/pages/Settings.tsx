import { createSignal, onMount, Show, For, createResource } from "solid-js";

import { api, currentSession, setSession, type PublicUser } from "../api";
import { PageTitle, navigate } from "../chrome";
import { usalItems } from "../motion";
import { renderGoogleButton } from "../google";
import AccountSecurity from "./AccountSecurity";
import {
  ACCENTS,
  Badge,
  Btn,
  Card,
  CardHeader,
  CopyButton,
  Icon,
  IconBtn,
  Icons,
  Input,
  Modal,
  ModalNotice,
  OtpPinField,
  Segmented,
  accent,
  copyWithToast,
  fmtDate,
  setAccent,
  setThemeMode,
  themeMode,
  toast,
  type AccentName,
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
  const [pwTotpCode, setPwTotpCode] = createSignal("");

  // totp section
  const [totpSetup, setTotpSetup] = createSignal<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = createSignal("");
  const [setupVerifyOpen, setSetupVerifyOpen] = createSignal(false);
  const [totpSetupPassword, setTotpSetupPassword] = createSignal("");
  const [disableTotpOpen, setDisableTotpOpen] = createSignal(false);
  const [totpDisableCode, setTotpDisableCode] = createSignal("");
  const [totpDisablePassword, setTotpDisablePassword] = createSignal("");

  // google link / unlink step-up
  let googleDiv: HTMLDivElement | undefined;
  const [googleClientId, setGoogleClientId] = createSignal<string | null>(null);
  const [pendingGoogleIdToken, setPendingGoogleIdToken] = createSignal<string | null>(null);
  const [googleLinkPassword, setGoogleLinkPassword] = createSignal("");
  const [googleLinkCode, setGoogleLinkCode] = createSignal("");
  const [unlinkGoogleOpen, setUnlinkGoogleOpen] = createSignal(false);
  const [googleUnlinkPassword, setGoogleUnlinkPassword] = createSignal("");
  const [googleUnlinkCode, setGoogleUnlinkCode] = createSignal("");

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

  const submitGoogleLink = async (idToken: string, currentPassword?: string, code?: string) => {
    setBusy(true);
    try {
      await api("POST", "/api/me/google/link", {
        idToken,
        ...(currentPassword ? { currentPassword } : {}),
        ...(code ? { code } : {}),
      });
      toast("Google account linked");
      setPendingGoogleIdToken(null);
      setGoogleLinkPassword("");
      setGoogleLinkCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "link failed", "err");
    } finally {
      setBusy(false);
    }
  };

  onMount(async () => {
    if (me().googleLinked) return;
    try {
      const cfg = await api<{ googleClientId: string | null }>("GET", "/api/auth/config");
      setGoogleClientId(cfg.googleClientId);
      if (cfg.googleClientId && googleDiv) {
        renderGoogleButton(googleDiv, cfg.googleClientId, async (idToken) => {
          if (me().hasPassword || me().totpEnabled) {
            setGoogleLinkPassword("");
            setGoogleLinkCode("");
            setPendingGoogleIdToken(idToken);
            return;
          }
          await submitGoogleLink(idToken);
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
    if (me().hasPassword && !curPw()) return toast("Enter your current password", "err");
    if (me().totpEnabled && pwTotpCode().trim().length !== 6) {
      return toast("Enter your 6-digit authenticator code", "err");
    }
    setBusy(true);
    try {
      await api("POST", "/api/me/password", {
        currentPassword: curPw() || undefined,
        newPassword: newPw(),
        ...(me().totpEnabled ? { totpCode: pwTotpCode().trim() } : {}),
      });
      toast("Password updated");
      setCurPw("");
      setNewPw("");
      setNewPw2("");
      setPwTotpCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const startTotp = async (currentPassword?: string) => {
    setBusy(true);
    try {
      const j = await api<{ secret: string; otpauthUri: string; qrDataUrl: string }>(
        "POST",
        "/api/me/2fa/setup",
        currentPassword ? { currentPassword } : {},
      );
      setSetupVerifyOpen(false);
      setTotpSetupPassword("");
      setTotpSetup(j);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const openTotpSetup = () => {
    if (me().hasPassword) {
      setTotpSetupPassword("");
      setSetupVerifyOpen(true);
      return;
    }
    void startTotp();
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
      await api("POST", "/api/me/2fa/disable", {
        code: totpDisableCode(),
        ...(me().hasPassword ? { currentPassword: totpDisablePassword() } : {}),
      });
      toast("Two-factor authentication disabled");
      setDisableTotpOpen(false);
      setTotpDisableCode("");
      setTotpDisablePassword("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "invalid verification", "err");
    } finally {
      setBusy(false);
    }
  };

  const unlinkGoogle = async () => {
    setBusy(true);
    try {
      await api("DELETE", "/api/me/google/link", {
        ...(me().hasPassword ? { currentPassword: googleUnlinkPassword() } : {}),
        ...(me().totpEnabled ? { code: googleUnlinkCode().trim() } : {}),
      });
      toast("Google account unlinked");
      setUnlinkGoogleOpen(false);
      setGoogleUnlinkPassword("");
      setGoogleUnlinkCode("");
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
      <PageTitle title="Settings" subtitle="Your profile, sign-in security and active browser sessions." />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card motion="fade-u duration-250">
          <CardHeader title="Profile & appearance" />
          <div class="px-5 pb-5 space-y-5">
            <div class="space-y-4">
              <div class="flex items-end gap-3">
                <div class="flex-1">
                  <Input label="Display name" value={name()} onInput={setName} />
                </div>
                <Btn onClick={saveName} disabled={busy() || !name().trim() || name() === me().name}>Save</Btn>
              </div>
              <div>
                <span class="block text-xs font-medium text-fg-secondary mb-1">Email</span>
                <div class="text-xs text-fg-secondary font-mono">{me().email}</div>
              </div>
            </div>

            <div class="pt-4 border-t border-line space-y-4">
              <div>
                <span class="block text-xs font-medium text-fg-secondary mb-0.5">Appearance</span>
                <p class="text-xs text-fg-muted mb-3">Light, dark, high contrast, or follow system automatically</p>
                <Segmented
                  value={themeMode()}
                  onChange={setThemeMode}
                  options={[
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                    { value: "high-contrast", label: "High contrast" },
                    { value: "system", label: "System" },
                  ]}
                />
              </div>

              <div>
                <span class="block text-xs font-medium text-fg-secondary mb-0.5">Accent color</span>
                <p class="text-xs text-fg-muted mb-2.5">Customize the primary interactive accent across the workspace</p>
                <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Accent color">
                  <For each={ACCENTS}>
                    {(item) => (
                      <button
                        type="button"
                        onClick={() => setAccent(item.id as AccentName)}
                        aria-pressed={accent() === item.id}
                        class={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-pill text-xs font-medium border transition-colors cursor-pointer ${
                          accent() === item.id
                            ? "border-accent bg-accent-subtle text-accent-strong"
                            : "border-line bg-surface-muted text-fg-secondary hover:text-fg"
                        }`}
                      >
                        <span
                          class="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: item.swatch }}
                        />
                        {item.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <Card motion="fade-u duration-250">
          <CardHeader title="Password" subtitle={me().hasPassword ? undefined : "Set account password"} />
          <div class="px-5 pb-5 space-y-4">
            <Show
              when={me().hasPassword}
              fallback={
                <p class="text-xs text-fg-muted">
                  Setting a password for the first time requires a recent sign-in (within the last 5 minutes).
                </p>
              }
            >
              <Input label="Current password" type="password" value={curPw()} onInput={setCurPw} autocomplete="current-password" />
            </Show>
            <Input label="New password" type="password" value={newPw()} onInput={setNewPw} autocomplete="new-password" hint="At least 10 characters" />
            <Input label="Confirm new password" type="password" value={newPw2()} onInput={setNewPw2} autocomplete="new-password" />
            <Show when={me().totpEnabled}>
              <OtpPinField
                label="Current 6-digit authenticator code"
                ariaLabel="Current 6-digit authenticator code"
                value={pwTotpCode()}
                onInput={setPwTotpCode}
                placeholder="123456"
                hint="Required when two-factor authentication is enabled."
              />
            </Show>
            <div class="flex justify-end">
              <Btn
                onClick={savePassword}
                disabled={
                  busy() ||
                  !newPw() ||
                  (me().hasPassword && !curPw()) ||
                  (me().totpEnabled && pwTotpCode().trim().length !== 6)
                }
              >
                Update password
              </Btn>
            </div>
          </div>
        </Card>

        <Card class="lg:col-span-2" motion="fade-u duration-300">
          <div class="p-5">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div class="space-y-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-medium text-fg">Two-factor authentication</h3>
                    <p class="text-xs text-fg-secondary mt-0.5">Authenticator app (TOTP)</p>
                  </div>
                  <Badge tone={me().totpEnabled ? "green" : "zinc"}>{me().totpEnabled ? "Enabled" : "Disabled"}</Badge>
                </div>

                <Show
                  when={me().totpEnabled}
                  fallback={
                    <div class="space-y-3">
                      <p class="text-xs text-fg-secondary">Add an extra layer of security using an authenticator app.</p>
                      <Btn variant="outline" onClick={openTotpSetup} disabled={busy()}>
                        <Icon name={Icons.shield} /> Set up 2FA
                      </Btn>
                    </div>
                  }
                >
                  <div class="space-y-3">
                    <p class="text-xs text-fg-secondary">Your account requires a 6-digit code at sign-in.</p>
                    <Btn
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        setTotpDisableCode("");
                        setTotpDisablePassword("");
                        setDisableTotpOpen(true);
                      }}
                    >
                      Disable 2FA
                    </Btn>
                  </div>
                </Show>
              </div>

              <div class="space-y-4 pt-5 lg:pt-0 border-t lg:border-t-0 lg:border-l border-line lg:pl-6">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <h3 class="text-sm font-medium text-fg">Google account</h3>
                  </div>
                  <Badge tone={me().googleLinked ? "green" : "zinc"}>{me().googleLinked ? "Linked" : "Not linked"}</Badge>
                </div>

                <Show
                  when={me().googleLinked}
                  fallback={
                    <Show when={googleClientId()} fallback={<p class="text-xs text-fg-muted">Google sign-in is not configured on this gateway.</p>}>
                      <p class="text-xs text-fg-secondary">Link any Google account to sign in with it — the email does not need to match:</p>
                      <div ref={googleDiv} class="inline-flex overflow-hidden rounded-full" />
                    </Show>
                  }
                >
                  <p class="text-sm text-fg-secondary">You can sign in using your Google account.</p>
                  <Btn
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setGoogleUnlinkPassword("");
                      setGoogleUnlinkCode("");
                      setUnlinkGoogleOpen(true);
                    }}
                    disabled={busy()}
                  >
                    Unlink Google
                  </Btn>
                </Show>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <AccountSecurity />
      <Card class="mt-6" motion="fade-u duration-300">
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
                            <span class={`text-sm truncate font-medium ${s.current ? "text-accent" : "text-fg"}`}>
                              {s.label || "Unnamed device"}
                            </span>
                            <button
                              type="button"
                              class="text-fg-muted hover:text-fg p-0.5 rounded hover:bg-surface-muted cursor-pointer transition-colors"
                              aria-label={s.label ? "Rename device" : "Name this device"}
                              data-tip={s.label ? "Rename device" : "Name this device"}
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
                            class="ui-field w-44 py-1 text-xs"
                          />
                          <Btn size="sm" onClick={saveSessionLabel}>Save</Btn>
                          <Btn size="sm" variant="ghost" onClick={() => setNamingJti(null)}>Cancel</Btn>
                        </div>
                      </Show>
                      {s.current ? <Badge tone="indigo">This session</Badge> : null}
                    </div>

                    <div class="text-xs text-fg-muted mt-1 space-x-1.5">
                      <span class="font-mono text-fg-secondary">{s.ip ?? "unknown ip"}</span>
                      <span>·</span>
                      <span>created {fmtDate(s.createdAt)}</span>
                      <span>·</span>
                      <span>last used {fmtDate(s.lastUsedAt)}</span>
                    </div>

                    <Show when={parseUa(s.ua)}>
                      <div class="text-xs text-fg-muted truncate max-w-md mt-0.5">{parseUa(s.ua)}</div>
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

      {/* 2FA Setup Password Verification Modal */}
      <Modal
        open={setupVerifyOpen()}
        onClose={() => { setSetupVerifyOpen(false); setTotpSetupPassword(""); }}
        title="Verify your password"
        subtitle="Confirm your current account password before generating a new two-factor secret."
        width="max-w-md"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => { setSetupVerifyOpen(false); setTotpSetupPassword(""); }}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={() => void startTotp(totpSetupPassword())}
              loading={busy()}
              disabled={!totpSetupPassword()}
            >
              Continue
            </Btn>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (totpSetupPassword() && !busy()) void startTotp(totpSetupPassword());
          }}
          class="space-y-4"
        >
          <Input
            label="Current password"
            type="password"
            value={totpSetupPassword()}
            onInput={setTotpSetupPassword}
            autocomplete="current-password"
            required
          />
        </form>
      </Modal>

      {/* 2FA Setup Modal */}
      <Modal
        open={!!totpSetup()}
        onClose={() => { setTotpSetup(null); setTotpCode(""); }}
        title="Set up two-factor authentication"
        subtitle="Scan the QR code with your authenticator app (1Password, Google Authenticator, Aegis…)"
        footer={
          <>
            <Btn variant="ghost" onClick={() => { setTotpSetup(null); setTotpCode(""); }}>Cancel</Btn>
            <Btn onClick={enableTotp} loading={busy()} disabled={totpCode().length !== 6}>
              Enable 2FA
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <div class="p-4 rounded-control border border-line bg-surface-muted flex flex-col sm:flex-row gap-5 items-center sm:items-start">
            <div class="flex flex-col items-center shrink-0">
              <img
                src={totpSetup()?.qrDataUrl}
                alt="TOTP QR code"
                class="w-36 h-36 rounded-lg border border-line p-2 shrink-0 shadow-xs"
                style={{ background: "oklch(1 0 0)" }}
              />
              <span class="text-xs text-fg-muted mt-2">Scan with your app</span>
            </div>
            <div class="flex-1 w-full space-y-3.5 min-w-0">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <span class="text-xs font-medium text-fg-secondary">Manual setup key</span>
                  <CopyButton text={totpSetup()?.secret ?? ""} label="Copy secret key" />
                </div>
                <div
                  onClick={() => copyWithToast(totpSetup()?.secret ?? "")}
                  class="rounded-control border border-line bg-surface px-3 py-2 text-center cursor-pointer hover:border-accent transition-colors group"
                  data-tip="Click to copy secret key"
                >
                  <code class="text-xs font-mono text-success tracking-wider select-all block break-all">
                    {totpSetup()?.secret?.match(/.{1,4}/g)?.join(" ") ?? totpSetup()?.secret}
                  </code>
                </div>
              </div>

              <OtpPinField
                label="Verification code"
                ariaLabel="Verification code"
                value={totpCode()}
                onInput={setTotpCode}
                placeholder="000 000"
                autofocus
                hint="Enter the 6-digit code from your authenticator app"
              />
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        open={disableTotpOpen()}
        onClose={() => { setDisableTotpOpen(false); setTotpDisableCode(""); setTotpDisablePassword(""); }}
        title="Disable two-factor authentication"
        subtitle={
          me().hasPassword
            ? "Confirm your current password and 6-digit authenticator code before removing 2FA protection."
            : "Confirm with your current 6-digit authenticator code before removing 2FA protection."
        }
        width="max-w-md"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => { setDisableTotpOpen(false); setTotpDisableCode(""); setTotpDisablePassword(""); }}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={disableTotp}
              loading={busy()}
              disabled={totpDisableCode().length !== 6 || (me().hasPassword && !totpDisablePassword())}
            >
              Disable 2FA
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <Show
            when={me().hasPassword}
            fallback={
              <p class="text-xs text-fg-muted">
                Accounts without a password require a recent sign-in (within the last 5 minutes).
              </p>
            }
          >
            <Input
              label="Current password"
              type="password"
              value={totpDisablePassword()}
              onInput={setTotpDisablePassword}
              autocomplete="current-password"
              required
            />
          </Show>
          <OtpPinField
            label="Current 6-digit authenticator code"
            ariaLabel="Current 6-digit authenticator code"
            value={totpDisableCode()}
            onInput={setTotpDisableCode}
            placeholder="123456"
            hint="Enter the numerical code from Google Authenticator, 1Password, or Authy."
          />

          <ModalNotice tone="warn" title="Reduced account protection">
            Disabling 2FA removes the second security layer. Your account will only require a password or Google OAuth to sign in.
          </ModalNotice>
        </div>
      </Modal>

      {/* Google Link Step-Up Modal */}
      <Modal
        open={pendingGoogleIdToken() !== null}
        onClose={() => { setPendingGoogleIdToken(null); setGoogleLinkPassword(""); setGoogleLinkCode(""); }}
        title="Confirm Google account link"
        subtitle="Verify your identity before linking this Google account."
        width="max-w-md"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => { setPendingGoogleIdToken(null); setGoogleLinkPassword(""); setGoogleLinkCode(""); }}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={() => {
                const token = pendingGoogleIdToken();
                if (!token) return;
                void submitGoogleLink(
                  token,
                  me().hasPassword ? googleLinkPassword() : undefined,
                  me().totpEnabled ? googleLinkCode().trim() : undefined,
                );
              }}
              loading={busy()}
              disabled={
                (me().hasPassword && !googleLinkPassword()) ||
                (me().totpEnabled && googleLinkCode().trim().length !== 6)
              }
            >
              Link Google
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <Show when={me().hasPassword}>
            <Input
              label="Current password"
              type="password"
              value={googleLinkPassword()}
              onInput={setGoogleLinkPassword}
              autocomplete="current-password"
              required
            />
          </Show>
          <Show when={me().totpEnabled}>
            <OtpPinField
              label="Current 6-digit authenticator code"
              ariaLabel="Current 6-digit authenticator code"
              value={googleLinkCode()}
              onInput={setGoogleLinkCode}
              placeholder="123456"
            />
          </Show>
        </div>
      </Modal>

      {/* Google Unlink Step-Up Modal */}
      <Modal
        open={unlinkGoogleOpen()}
        onClose={() => { setUnlinkGoogleOpen(false); setGoogleUnlinkPassword(""); setGoogleUnlinkCode(""); }}
        title="Unlink Google account"
        subtitle="Verify your identity before removing Google sign-in from your account."
        width="max-w-md"
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => { setUnlinkGoogleOpen(false); setGoogleUnlinkPassword(""); setGoogleUnlinkCode(""); }}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={unlinkGoogle}
              loading={busy()}
              disabled={
                !me().hasPassword ||
                !googleUnlinkPassword() ||
                (me().totpEnabled && googleUnlinkCode().trim().length !== 6)
              }
            >
              Unlink Google
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <Show
            when={me().hasPassword}
            fallback={
              <ModalNotice tone="warn" title="Password required">
                Set an account password first so you do not lose access after unlinking Google.
              </ModalNotice>
            }
          >
            <Input
              label="Current password"
              type="password"
              value={googleUnlinkPassword()}
              onInput={setGoogleUnlinkPassword}
              autocomplete="current-password"
              required
            />
            <Show when={me().totpEnabled}>
              <OtpPinField
                label="Current 6-digit authenticator code"
                ariaLabel="Current 6-digit authenticator code"
                value={googleUnlinkCode()}
                onInput={setGoogleUnlinkCode}
                placeholder="123456"
              />
            </Show>
          </Show>
        </div>
      </Modal>
    </div>
  );
}

// keep the navigate import used (for future deep links)
void navigate;
