import { For, Show, createMemo, createSignal, createUniqueId, type JSX } from "solid-js";
import { Icon as Glyph } from "../../components/icon";
import { createGlide } from "../motion/glide";
import { press } from "../motion/press";

/**
 * Studio Controls — bespoke, tactile interactive form instruments for
 * creation, editing, and policy configuration dialogs across Indirect Gateway
 * and Indirect Code.
 *
 * Every control preserves a real, accessible native `<input>` (`type="number"`,
 * `type="text"`, `type="password"`, `type="checkbox"`, `type="datetime-local"`)
 * with its exact label/aria-label association so keyboard navigation, screen
 * readers, and automated browser suites operate natively.
 */

export interface PresetOption {
  label: string;
  value: string;
}

export interface BreakdownSlice {
  label: string;
  value: string;
  active?: boolean;
}

/**
 * Precision USD budget & allowance composer with live status readout,
 * tactile micro-steppers, one-tap preset rail, and optional proportional
 * distribution preview.
 */
export function CurrencyField(props: {
  label?: string;
  hint?: string;
  ariaLabel?: string;
  value: string;
  onInput: (value: string) => void;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  placeholder?: string;
  presets?: readonly PresetOption[];
  breakdown?: readonly BreakdownSlice[];
  allowEmpty?: boolean;
  required?: boolean;
  disabled?: boolean;
}) {
  const fieldId = createUniqueId();
  const numeric = createMemo(() => {
    const raw = props.value.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  });

  const adjust = (delta: number) => {
    if (props.disabled) return;
    const current = numeric() ?? 0;
    const minVal = props.min !== undefined ? Number(props.min) : 0;
    const maxVal = props.max !== undefined ? Number(props.max) : 1_000_000;
    const next = Math.min(maxVal, Math.max(minVal, Math.round((current + delta) * 100) / 100));
    props.onInput(String(next));
  };

  const formattedBadge = createMemo(() => {
    const n = numeric();
    if (n === null) return props.allowEmpty !== false ? "∞ Unlimited" : "$0.00";
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })} USD`;
  });

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <div class="ui-studio-header">
          <label for={fieldId} class="ui-label !mb-0">{props.label}</label>
          <span class={`ui-studio-readout ${numeric() !== null ? "is-active" : ""}`} aria-hidden="true">
            {formattedBadge()}
          </span>
        </div>
      </Show>

      <div class="ui-studio-frame">
        <div class="ui-studio-input-row">
          <span class="ui-studio-currency-symbol" aria-hidden="true">$</span>
          <input
            id={fieldId}
            type="number"
            inputMode="decimal"
            aria-label={props.ariaLabel ?? props.label}
            min={props.min ?? 0}
            max={props.max}
            step={props.step ?? "0.01"}
            required={props.required}
            disabled={props.disabled}
            value={props.value}
            placeholder={props.placeholder ?? "Unlimited"}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            class="ui-studio-input billing-money-input font-mono"
          />
          <div class="ui-studio-actions" aria-hidden="true">
            <button
              type="button"
              tabIndex={-1}
              disabled={props.disabled}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => adjust(-5)}
              class="ui-studio-step-btn"
              title="Decrease by $5"
            >
              <Glyph icon="lucide:minus" size={12} />
            </button>
            <button
              type="button"
              tabIndex={-1}
              disabled={props.disabled}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => adjust(5)}
              class="ui-studio-step-btn"
              title="Increase by $5"
            >
              <Glyph icon="lucide:plus" size={12} />
            </button>
            <Show when={props.allowEmpty !== false && props.value !== ""}>
              <button
                type="button"
                tabIndex={-1}
                disabled={props.disabled}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => props.onInput("")}
                class="ui-studio-step-btn ui-studio-clear-btn"
                title="Reset to unlimited"
              >
                <Glyph icon="lucide:infinity" size={12} />
              </button>
            </Show>
          </div>
        </div>

        <Show when={props.presets && props.presets.length > 0}>
          <div class="ui-studio-preset-rail" aria-hidden="true">
            <For each={props.presets}>
              {(preset) => {
                const active = () =>
                  preset.value === ""
                    ? props.value.trim() === ""
                    : Number(props.value) === Number(preset.value) && props.value.trim() !== "";
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={props.disabled}
                    onPointerDown={(e) => press(e.currentTarget)}
                    onClick={() => props.onInput(preset.value)}
                    class={`ui-studio-preset-pill ${active() ? "is-active" : ""}`}
                  >
                    {preset.label}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <Show when={props.breakdown && props.breakdown.length > 0}>
          <div class="ui-studio-breakdown" aria-hidden="true">
            <For each={props.breakdown}>
              {(item) => (
                <div class={`ui-studio-breakdown-cell ${item.active ? "is-active" : ""}`}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Tactile precision number stepper with unit badge and one-tap preset chips
 * (for RPM rate limits, failover priority tiers, token windows, and reset counts).
 */
export function StepperField(props: {
  label?: string;
  hint?: string;
  ariaLabel?: string;
  value: string | number;
  onInput: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  readout?: string;
  placeholder?: string;
  presets?: readonly PresetOption[];
  disabled?: boolean;
}) {
  const fieldId = createUniqueId();
  const strValue = () => String(props.value ?? "");
  const numeric = createMemo(() => {
    const raw = strValue().trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  });

  const adjust = (dir: -1 | 1) => {
    if (props.disabled) return;
    const step = props.step ?? 1;
    const current = numeric() ?? (props.min ?? 0);
    const minVal = props.min ?? 0;
    const maxVal = props.max ?? 10_000_000;
    const next = Math.min(maxVal, Math.max(minVal, current + dir * step));
    props.onInput(String(next));
  };

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <div class="ui-studio-header">
          <label for={fieldId} class="ui-label !mb-0">{props.label}</label>
          <Show when={props.readout || props.unit}>
            <span class={`ui-studio-readout ${numeric() !== null ? "is-active" : ""}`} aria-hidden="true">
              {props.readout ?? (numeric() !== null ? `${numeric()!.toLocaleString()} ${props.unit ?? ""}`.trim() : props.placeholder ?? "Default")}
            </span>
          </Show>
        </div>
      </Show>

      <div class="ui-studio-frame">
        <div class="ui-studio-input-row">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={props.disabled}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => adjust(-1)}
            class="ui-studio-step-btn"
          >
            <Glyph icon="lucide:minus" size={12} />
          </button>
          <input
            id={fieldId}
            type="number"
            aria-label={props.ariaLabel ?? props.label}
            min={props.min}
            max={props.max}
            step={props.step ?? 1}
            disabled={props.disabled}
            value={strValue()}
            placeholder={props.placeholder}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            class="ui-studio-input font-mono text-center"
          />
          <Show when={props.unit}>
            <span class="ui-studio-unit" aria-hidden="true">{props.unit}</span>
          </Show>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={props.disabled}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => adjust(1)}
            class="ui-studio-step-btn"
          >
            <Glyph icon="lucide:plus" size={12} />
          </button>
        </div>

        <Show when={props.presets && props.presets.length > 0}>
          <div class="ui-studio-preset-rail" aria-hidden="true">
            <For each={props.presets}>
              {(preset) => {
                const active = () => strValue().trim() === preset.value;
                return (
                  <button
                    type="button"
                    tabIndex={-1}
                    disabled={props.disabled}
                    onPointerDown={(e) => press(e.currentTarget)}
                    onClick={() => props.onInput(preset.value)}
                    class={`ui-studio-preset-pill ${active() ? "is-active" : ""}`}
                  >
                    {preset.label}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Interactive chip & capability matrix synced with a comma-separated input
 * (for model modalities, sampling parameters, features, reasoning efforts,
 * and provider blocked parameters).
 */
export function TokenTagField(props: {
  label?: string;
  hint?: string;
  ariaLabel?: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  suggestions: readonly (string | { value: string; label?: string; icon?: string })[];
}) {
  const fieldId = createUniqueId();
  const normalizedSuggestions = createMemo(() =>
    props.suggestions.map((s) => (typeof s === "string" ? { value: s, label: s, icon: undefined } : s)),
  );
  const tokens = createMemo(() =>
    props.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  const hasToken = (token: string) =>
    tokens().some((t) => t.toLowerCase() === token.toLowerCase());

  const toggleToken = (token: string) => {
    const current = tokens();
    const exists = current.some((t) => t.toLowerCase() === token.toLowerCase());
    const next = exists
      ? current.filter((t) => t.toLowerCase() !== token.toLowerCase())
      : [...current, token];
    props.onInput(next.join(", "));
  };

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <div class="ui-studio-header">
          <label for={fieldId} class="ui-label !mb-0">{props.label}</label>
          <span class={`ui-studio-readout ${tokens().length > 0 ? "is-active" : ""}`} aria-hidden="true">
            {tokens().length === 0 ? "None" : `${tokens().length} enabled`}
          </span>
        </div>
      </Show>

      <div class="ui-studio-frame">
        <div class="ui-studio-tag-matrix" aria-hidden="true">
          <For each={normalizedSuggestions()}>
            {(item) => {
              const active = () => hasToken(item.value);
              return (
                <button
                  type="button"
                  tabIndex={-1}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => toggleToken(item.value)}
                  class={`ui-studio-tag-chip ${active() ? "is-active" : ""}`}
                >
                  <Glyph
                    icon={active() ? "lucide:check" : item.icon ?? "lucide:plus"}
                    size={11}
                  />
                  <span>{item.label ?? item.value}</span>
                </button>
              );
            }}
          </For>
        </div>

        <div class="ui-studio-input-row ui-studio-tag-input-row">
          <Glyph icon="lucide:terminal" size={13} class="text-fg-muted shrink-0 ml-2.5" />
          <input
            id={fieldId}
            type="text"
            aria-label={props.ariaLabel ?? props.label}
            value={props.value}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            placeholder={props.placeholder}
            class="ui-studio-input font-mono text-xs"
          />
          <Show when={tokens().length > 0}>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden="true"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => props.onInput("")}
              class="ui-studio-step-btn ui-studio-clear-btn mr-1"
              title="Clear all"
            >
              <Glyph icon="lucide:x" size={12} />
            </button>
          </Show>
        </div>
      </div>

      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Gliding studio selection cards with icon tiles, descriptions, and a shared
 * spring-animated indicator (for user roles, account statuses, and scopes).
 */
export function RoleCardGroup(props: {
  label?: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly {
    value: string;
    label: string;
    description?: string;
    icon?: string;
    tone?: "default" | "danger" | "success";
  }[];
  columns?: 2 | 3;
}) {
  const [container, setContainer] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();

  createGlide({
    container,
    indicator,
    target: () => {
      void props.value;
      return container()?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;
    },
  });

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <span class="ui-label">{props.label}</span>
      </Show>
      <div
        ref={setContainer}
        data-glide=""
        class={`ui-studio-card-group ${props.columns === 2 ? "is-cols-2" : "is-cols-3"}`}
      >
        <span ref={setIndicator} class="ui-studio-card-indicator" aria-hidden="true" />
        <For each={props.options}>
          {(opt) => {
            const selected = () => props.value === opt.value;
            return (
              <button
                type="button"
                aria-pressed={selected()}
                aria-label={opt.label}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => props.onChange(opt.value)}
                class={`ui-studio-choice-card ${selected() ? "is-selected" : ""} ${
                  opt.tone === "danger" ? "is-danger" : opt.tone === "success" ? "is-success" : ""
                }`}
              >
                <div class="ui-studio-choice-top" aria-hidden="true">
                  <span class="ui-studio-choice-icon">
                    <Glyph icon={opt.icon ?? "lucide:shield"} size={14} />
                  </span>
                  <span class="ui-studio-choice-dot" />
                </div>
                <span class="ui-studio-choice-label" aria-hidden="true">{opt.label}</span>
                <Show when={opt.description}>
                  <span class="ui-studio-choice-desc" aria-hidden="true">{opt.description}</span>
                </Show>
              </button>
            );
          }}
        </For>
      </div>
      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Encrypted credential vault input with live prefix/format detection,
 * AES-256-GCM security badge, and reveal toggle.
 */
export function SecretField(props: {
  label?: string;
  hint?: string;
  ariaLabel?: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autocomplete?: string;
  badge?: string;
}) {
  const fieldId = createUniqueId();
  const [revealed, setRevealed] = createSignal(false);

  const detectedFormat = createMemo(() => {
    const v = props.value.trim();
    if (!v) return props.badge ?? "AES-256-GCM";
    if (v.startsWith("sk-ant-")) return "Anthropic key · AES-256";
    if (v.startsWith("sk-proj-") || v.startsWith("sk-")) return "OpenAI key · AES-256";
    if (v.startsWith("AIza")) return "Google key · AES-256";
    return `${v.length} chars · AES-256`;
  });

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <div class="ui-studio-header">
          <label for={fieldId} class="ui-label !mb-0">{props.label}</label>
          <span class={`ui-studio-readout ${props.value.trim() ? "is-active" : ""}`} aria-hidden="true">
            <Glyph icon="lucide:lock" size={11} />
            <span>{detectedFormat()}</span>
          </span>
        </div>
      </Show>

      <div class="ui-studio-frame">
        <div class="ui-studio-input-row">
          <span class="ui-studio-currency-symbol" aria-hidden="true">
            <Glyph icon="lucide:key-round" size={14} />
          </span>
          <input
            id={fieldId}
            type={revealed() ? "text" : "password"}
            aria-label={props.ariaLabel ?? props.label}
            value={props.value}
            required={props.required}
            autocomplete={props.autocomplete ?? "off"}
            placeholder={props.placeholder ?? "sk-…"}
            onInput={(e) => props.onInput(e.currentTarget.value)}
            class="ui-studio-input font-mono"
          />
          <div class="ui-studio-actions" aria-hidden="true">
            <button
              type="button"
              tabIndex={-1}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => setRevealed((v) => !v)}
              class="ui-studio-step-btn"
              title={revealed() ? "Hide secret" : "Reveal secret"}
            >
              <Glyph icon={revealed() ? "lucide:eye-off" : "lucide:eye"} size={13} />
            </button>
          </div>
        </div>
      </div>

      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Segmented 6-digit authenticator OTP pin pad overlaid on a native single
 * input so keyboard entry, paste, autofill, and test `.fill()` work seamlessly.
 */
export function OtpPinField(props: {
  label?: string;
  hint?: string;
  ariaLabel?: string;
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  autofocus?: boolean;
}) {
  const fieldId = createUniqueId();
  const [focused, setFocused] = createSignal(false);
  const digits = createMemo(() => {
    const clean = props.value.replace(/\s+/g, "").slice(0, 6);
    return Array.from({ length: 6 }, (_, i) => clean[i] ?? "");
  });
  const activeIdx = createMemo(() => {
    const cleanLen = props.value.replace(/\s+/g, "").length;
    return Math.min(5, cleanLen);
  });

  return (
    <div class="ui-studio-field">
      <Show when={props.label}>
        <div class="ui-studio-header">
          <label for={fieldId} class="ui-label !mb-0">{props.label}</label>
          <span class={`ui-studio-readout ${props.value.length === 6 ? "is-active" : ""}`} aria-hidden="true">
            {props.value.length}/6 digits
          </span>
        </div>
      </Show>

      <div class="ui-studio-otp-wrap">
        <div class="ui-studio-otp-slots" aria-hidden="true">
          <For each={digits()}>
            {(char, idx) => (
              <>
                <Show when={idx() === 3}>
                  <span class="ui-studio-otp-sep">·</span>
                </Show>
                <div
                  class={`ui-studio-otp-slot ${char ? "is-filled" : ""} ${
                    focused() && activeIdx() === idx() ? "is-Current" : ""
                  }`}
                >
                  {char || "•"}
                </div>
              </>
            )}
          </For>
        </div>
        <input
          id={fieldId}
          type="text"
          inputMode="numeric"
          aria-label={props.ariaLabel ?? props.label}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value.trim())}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={props.placeholder ?? "000 000"}
          autocomplete="one-time-code"
          maxLength={6}
          required={props.required}
          autofocus={props.autofocus}
          class="ui-studio-otp-input"
        />
      </div>

      <Show when={props.hint}>
        <p class="ui-hint">{props.hint}</p>
      </Show>
    </div>
  );
}

/**
 * Tactile spring checkbox card tile that wraps a real `<input type="checkbox">`
 * inside a `<label>` for rich multi-select lists and confirmation gates.
 */
export function CheckTile(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: JSX.Element;
  subtitle?: JSX.Element;
  description?: JSX.Element;
  badge?: JSX.Element;
  disabled?: boolean;
  tone?: "default" | "danger";
  class?: string;
}) {
  return (
    <label
      class={`ui-studio-check-tile ${props.checked ? "is-checked" : ""} ${
        props.tone === "danger" ? "is-danger" : ""
      } ${props.disabled ? "opacity-50 pointer-events-none" : ""} ${props.class ?? ""}`}
    >
      <input
        type="checkbox"
        class="ui-studio-check-input peer"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="ui-studio-check-box" aria-hidden="true">
        <Glyph icon="lucide:check" size={12} />
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center justify-between gap-2 flex-wrap">
          <span class="text-sm font-medium text-fg break-words">{props.title}</span>
          {props.badge}
        </span>
        <Show when={props.subtitle ?? props.description}>
          <span class="block text-xs text-fg-secondary mt-0.5 break-all">
            {props.subtitle ?? props.description}
          </span>
        </Show>
      </span>
    </label>
  );
}
