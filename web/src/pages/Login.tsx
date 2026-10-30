import { createSignal, onMount, Show } from "solid-js";

import { publicApi, setSession } from "../api";
import { usal } from "../motion";
import { Btn, Input, Spinner, Card, Icon, Icons, ThemeToggle, capitalize } from "../ui";
import { renderGoogleButton } from "../google";

/**
 * Login: email+password, optional TOTP step, Google Sign-In for linked
 * accounts, and the "forgot password" request flow (always answers the same
 * message to avoid account enumeration).
 */

declare global {
  interface Window {
    google?: any;
  }
}

/** Persist the session and hard-reload into the app (guarantees a clean state). */
function enterApp(tokens: { accessToken: string; refreshToken: string; user: any }): void {
  const destination = location.hash.startsWith("#/code") ? location.hash : "#/";
  setSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: tokens.user });
  location.hash = destination;
  location.reload();
}

export default function LoginPage() {
  const [mode, setMode] = createSignal<"login" | "2fa" | "forgot">("login");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [tempToken, setTempToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [googleClientId, setGoogleClientId] = createSignal<string | null>(null);
  const [oidcStart, setOidcStart] = createSignal<string | null>(null);

  let googleDiv: HTMLDivElement | undefined;

  onMount(async () => {
    const callback = new URLSearchParams(location.search).get("oidc");
    if (callback === "complete") {
      setBusy(true);
      history.replaceState(null, "", `${location.pathname}${location.hash}`);
      try {
        const result = await publicApi<any>("POST", "/api/auth/oidc/complete", {});
        if (result.needs2FA) { setTempToken(result.tempToken); setMode("2fa"); }
        else enterApp(result);
      } catch (e) { setError(e instanceof Error ? e.message : "Corporate sign-in failed"); }
      finally { setBusy(false); }
    }
    try {
      const cfg = await publicApi<{ googleClientId: string | null; smtpConfigured: boolean; oidcEnabled?: boolean; oidcStartUrl?: string }>(
        "GET",
        "/api/auth/config",
      );
      setGoogleClientId(cfg.googleClientId);
      if (cfg.oidcEnabled && cfg.oidcStartUrl?.startsWith("/api/auth/oidc/")) setOidcStart(cfg.oidcStartUrl);
      if (cfg.googleClientId && googleDiv) {
        renderGoogleButton(googleDiv, cfg.googleClientId, async (idToken) => {
          setBusy(true);
          setError("");
          try {
            const j = await publicApi<any>("POST", "/api/auth/google", { idToken });
            if (j.needs2FA) {
              setTempToken(j.tempToken);
              setMode("2fa");
              return;
            }
            enterApp(j);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Google sign-in failed");
          } finally {
            setBusy(false);
          }
        });
      }
    } catch {
      /* config failure leaves password login usable */
    }
  });

  const submitLogin = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/login", {
        email: email().trim(),
        password: password(),
      });
      if (j.needs2FA) {
        setTempToken(j.tempToken);
        setMode("2fa");
        return;
      }
      enterApp(j);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/2fa", {
        tempToken: tempToken(),
        code: code().replace(/\s/g, ""),
      });
      enterApp(j);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/password-reset/request", {
        email: email().trim(),
      });
      setInfo(j.message ?? "If the account exists, a reset email is on its way.");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative min-h-screen flex items-center justify-center px-4 py-10 overflow-hidden">
      <div class="absolute top-4 right-4 z-10">
        <ThemeToggle class="rounded-full bg-card/80 border border-line shadow-xs backdrop-blur" />
      </div>

      <div class="relative w-full max-w-sm">
        <div class="flex flex-col items-center mb-6" {...usal("fade-d duration-700")}>
          <div {...usal("zoomin-30 duration-700")}>
            <img
        src="/indirect-icon.svg"
        alt="Indirect"
        class="object-contain w-10 h-10 rounded-xl mb-4"
      />
          </div>
          <h1
            class="text-2xl font-semibold tracking-tight font-mono uppercase"
          >
            Indirect
          </h1>
          <p class="text-sm text-ink-400 mt-1.5">
            {mode() === "forgot" ? "Reset your password" : mode() === "2fa" ? "Two-factor verification" : "Sign in to your account"}
          </p>
        </div>

        <Card class="p-5 sm:p-6" {...usal("zoomin-15 duration-600 delay-150")}>
          <Show when={error()}>
            <div class="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/15 px-3.5 py-2.5 text-sm text-rose-300 dark:text-rose-200 flex items-center gap-2.5 anim-fade-in shadow-xs">
              <Icon name={Icons.warning} size={16} class="shrink-0 text-rose-400" />
              <span>{capitalize(error())}</span>
            </div>
          </Show>
          <Show when={info()}>
            <div class="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-3.5 py-2.5 text-sm text-emerald-300 dark:text-emerald-200 anim-fade-in shadow-xs">
              {info()}
            </div>
          </Show>

          <Show when={mode() === "login"}>
            <form onSubmit={submitLogin} class="space-y-4">
              <Input label="Email" type="email" value={email()} onInput={setEmail} autocomplete="email" required />
              <Input label="Password" type="password" value={password()} onInput={setPassword} autocomplete="current-password" required />
              <Btn type="submit" class="w-full" disabled={busy()}>
                {busy() ? <Spinner /> : "Sign in"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-400 hover:text-ink-200 transition-colors cursor-pointer py-1"
                onClick={() => { setMode("forgot"); setError(""); setInfo(""); }}
              >
                Forgot your password?
              </button>
            </form>
          </Show>

          <Show when={mode() === "2fa"}>
            <form onSubmit={submit2fa} class="space-y-4">
              <div class="flex items-center gap-2 text-sm text-ink-200">
                <span class="text-brand-500">
                  <Icon name={Icons.shield} size={16} />
                </span>
                Enter an authenticator code or a recovery code
              </div>
              <Input
                label="Authentication code"
                value={code()}
                onInput={setCode}
                placeholder="123456"
                autocomplete="one-time-code"
                required
              />
              <Btn type="submit" class="w-full" disabled={busy() || code().trim().length < 6}>
                {busy() ? <Spinner /> : "Verify"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-400 hover:text-ink-200 cursor-pointer py-1"
                onClick={() => { setMode("login"); setError(""); }}
              >
                Back
              </button>
            </form>
          </Show>

          <Show when={mode() === "forgot"}>
            <form onSubmit={submitForgot} class="space-y-4">
              <p class="text-sm text-ink-200">We'll email you a link to reset your password.</p>
              <Input label="Email" type="email" value={email()} onInput={setEmail} autocomplete="email" required />
              <Btn type="submit" class="w-full" disabled={busy()}>
                {busy() ? <Spinner /> : "Send reset link"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-400 hover:text-ink-200 cursor-pointer py-1"
                onClick={() => { setMode("login"); setError(""); setInfo(""); }}
              >
                Back to sign in
              </button>
            </form>
          </Show>

          <Show when={mode() === "login" && oidcStart()}><div class="mt-5 pt-5 border-t border-line"><Btn variant="outline" class="w-full" disabled={busy()} onClick={() => { const start = oidcStart(); if (start) location.assign(start); }}>Continue with corporate SSO</Btn></div></Show>
          <Show when={googleClientId() && mode() === "login"}>
            <div class="mt-5 pt-5 border-t border-line flex justify-center">
              {/* overflow-hidden + rounded-full clips the GSI iframe's white
                  background that would otherwise peek past the pill corners. */}
              <div ref={googleDiv} class="inline-flex overflow-hidden rounded-full" />
            </div>
          </Show>
        </Card>

        <p class="text-center text-[11px] text-ink-500 mt-6">
          <a href="/terms.html" target="_blank" class="hover:text-ink-300 transition-colors">Terms of Service</a>
          {" · "}
          <a href="/privacy.html" target="_blank" class="hover:text-ink-300 transition-colors">Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
