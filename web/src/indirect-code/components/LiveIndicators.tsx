import { For } from "solid-js";

const SPOKE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315] as const;
const BAR_X = [1.0, 4.1, 7.2, 10.3] as const;
const MATRIX_CELLS = [
  { r: 0, c: 0, x: 1.0, y: 1.0 },
  { r: 0, c: 1, x: 4.9, y: 1.0 },
  { r: 0, c: 2, x: 8.8, y: 1.0 },
  { r: 1, c: 0, x: 1.0, y: 4.9 },
  { r: 1, c: 1, x: 4.9, y: 4.9 },
  { r: 1, c: 2, x: 8.8, y: 4.9 },
  { r: 2, c: 0, x: 1.0, y: 8.8 },
  { r: 2, c: 1, x: 4.9, y: 8.8 },
  { r: 2, c: 2, x: 8.8, y: 8.8 },
] as const;

/**
 * Sidebar Running Session:
 * 8-Spoke Precision Radial Hairline Spinner (`r=3.2` to `r=5.8` around hollow center).
 */
export function RadialSpokeSpinner(props: { size?: number; class?: string; paused?: boolean }) {
  const s = () => props.size ?? 13;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
      data-indicator="radial-spokes"
      class={`shrink-0 ${props.paused ? "rc-indicator-paused" : ""} ${props.class ?? "text-fg-secondary"}`}
    >
      <For each={SPOKE_ANGLES}>
        {(angle, idx) => (
          <line
            x1="6.5"
            y1="0.75"
            x2="6.5"
            y2="3.3"
            transform={`rotate(${angle} 6.5 6.5)`}
            stroke="currentColor"
            stroke-width="1.35"
            stroke-linecap="round"
            class={`rc-spoke rc-spoke-${idx()}`}
          />
        )}
      </For>
    </svg>
  );
}

/**
 * Background Task Process Telemetry:
 * 4-Bar Sharp Rectangular Equalizer (`1.75px` wide, `rx="0.4"`, oscillating `3px..11px`).
 */
export function ProcessEqualizer(props: { size?: number; class?: string }) {
  const s = () => props.size ?? 13;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden="true"
      data-indicator="process-equalizer"
      class={`shrink-0 ${props.class ?? "text-accent"}`}
    >
      <For each={BAR_X}>
        {(x, idx) => (
          <rect
            x={x}
            y="1"
            width="1.75"
            height="11"
            rx="0.4"
            fill="currentColor"
            class={`rc-proc-bar rc-proc-bar-${idx()}`}
          />
        )}
      </For>
    </svg>
  );
}

/**
 * Turn Status ("Working"):
 * Bespoke 3x3 Neural Square Matrix (9 sharp `2.2x2.2` micro-squares `rx="0.35"`
 * illuminating in a silky diagonal wave `0.18 -> 1.0`).
 */
export function NeuralMatrixLoader(props: { size?: number; class?: string }) {
  const s = () => props.size ?? 12;
  return (
    <svg
      width={s()}
      height={s()}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      data-indicator="neural-matrix"
      class={`shrink-0 ${props.class ?? "text-accent"}`}
    >
      <For each={MATRIX_CELLS}>
        {(cell) => (
          <rect
            x={cell.x}
            y={cell.y}
            width="2.2"
            height="2.2"
            rx="0.35"
            fill="currentColor"
            class="rc-matrix-cell"
            style={{
              "animation-delay": `${-(cell.r + cell.c) * 0.24 - cell.r * 0.03}s`,
              "--cell-diag": String(cell.r + cell.c),
            }}
          />
        )}
      </For>
    </svg>
  );
}

/**
 * Cross-device unread / attention indicator ("bolinha"):
 * Crisp, static solid circle (`bg-accent`), zero glow, zero pulse.
 */
export function UnreadDot(props: { label?: string; size?: "sm" | "md"; class?: string }) {
  const dim = () => (props.size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2");
  return (
    <span
      data-indicator="unread-dot"
      data-rc-tip={props.label}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      class={`inline-block rounded-full bg-accent shrink-0 ${dim()} ${props.class ?? ""}`}
    />
  );
}
