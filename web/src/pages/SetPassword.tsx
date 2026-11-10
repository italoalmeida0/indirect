import { createMemo, createSignal, For, Show } from "solid-js";

import { publicApi } from "../api";
import { navigate, LogoMark } from "../chrome";
import { usal, usalItems } from "../motion";
import { Alert, Btn, Card, Icon, Icons, Input, ThemeToggle, capitalize } from "../ui";

const STRENGTH_SEGMENTS = [1, 2, 3, 4] as const;

function evaluateStrength(pw: string): { score: number; label: string; toneClass: string } {
  if (!pw) return { score: 0, label: "At least 10 characters", toneClass: "bg-line" };
  let score = 0;
  if (pw.length >= 10) score += 1;
  if (pw.length >= 14) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/\d/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score += 1;
  if (pw.length < 10) {
    return { score: 1, label: `${10 - pw.length} more characters required`, toneClass: "bg-danger" };
  }
  if (score <= 2) return { score: 2, label: "Fair strength", toneClass: "bg-warning" };
  if (score === 3) return { score: 3, label: "Good strength", toneClass: "bg-accent" };
  return { score: 4, label: "Strong password", toneClass: "bg-success" };
}

/** Landing page for invite + password-reset email links: `#/set-password?token=…` */
export default function SetPasswordPage(props: { query: URLSearchParams }) {
  const token = props.query.get("token") ?? "";
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal(false);

  const strength = createMemo(() => evaluateStrength(password()));

  const submit = async (e: Event) => {
    e.preventDefault();
    setError("");
    if (password() !== confirm()) return setError("Passwords do not match");
    if (password().length < 10) return setError("Password must be at least 10 characters");
    setBusy(true);
    try {
      await publicApi("POST", "/api/auth/password-reset/confirm", {
        token,
        password: password(),
      });
      setDone(true);
      setTimeout(() => navigate("/login"), 1800);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "This link is invalid or has expired");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative min-h-screen flex items-center justify-center px-4 py-10 overflow-hidden">
      <div
        class="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 45% at 50% -5%, var(--glow-brand), transparent 72%)",
        }}
      />
      <div class="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div class="relative w-full max-w-sm">
        <div class="flex flex-col items-center mb-6" {...usal("fade-d duration-700")}>
          <div {...usal("zoomin-30 duration-700")}>
            <LogoMark class="w-10 h-10 rounded-xl mb-4" />
          </div>
          <h1 class="text-2xl font-medium tracking-tight text-fg">Set your password</h1>
        </div>

        <Card class="p-5 sm:p-6" motion="zoomin-15 duration-600 delay-150">
          <Show
            when={token}
            fallback={
              <Alert tone="danger" icon={<Icon name={Icons.warning} size={16} />}>
                This link is missing its token. Ask for a new one.
              </Alert>
            }
          >
            <Show
              when={!done()}
              fallback={
                <Alert tone="success" icon={<Icon name={Icons.check} size={16} />}>
                  Password set. Redirecting you to sign in…
                </Alert>
              }
            >
              <Show when={error()}>
                <Alert tone="danger" class="mb-4" icon={<Icon name={Icons.warning} size={16} />}>
                  {capitalize(error())}
                </Alert>
              </Show>
              <form onSubmit={submit} class="space-y-4" {...usalItems("fade-u", 80)}>
                <div class="space-y-2">
                  <Input
                    label="New password"
                    type="password"
                    value={password()}
                    onInput={setPassword}
                    autocomplete="new-password"
                    required
                  />
                  <div class="space-y-1.5" aria-live="polite">
                    <div class="grid grid-cols-4 gap-1.5">
                      <For each={STRENGTH_SEGMENTS}>
                        {(seg) => (
                          <div
                            class={`h-1 rounded-full transition-colors duration-200 ${
                              strength().score >= seg ? strength().toneClass : "bg-line"
                            }`}
                          />
                        )}
                      </For>
                    </div>
                    <p class="text-xs text-fg-secondary">{strength().label}</p>
                  </div>
                </div>
                <Input
                  label="Confirm password"
                  type="password"
                  value={confirm()}
                  onInput={setConfirm}
                  autocomplete="new-password"
                  required
                />
                <Btn type="submit" class="w-full" loading={busy()}>
                  Save password
                </Btn>
              </form>
            </Show>
          </Show>
        </Card>
      </div>
    </div>
  );
}
