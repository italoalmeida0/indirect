import { For, Show } from "solid-js";
import { reducedMotion } from "../../ds/motion/reduced";
import { createShimmerStyle } from "../../ds/motion/shimmer";
import type { VoiceRevealState } from "./types";

export function VoiceStatusOverlay(props: {
  active: boolean;
  listening: boolean;
  statusText: string;
  statusMeta?: string;
}) {
  const shimmerStyle = createShimmerStyle(() => props.active);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={props.active ? undefined : "true"}
      data-voice-status-overlay
      data-active={props.active ? "true" : undefined}
      class="rc-voice-status-overlay pointer-events-none select-none absolute inset-0 flex items-start justify-between gap-3 px-3.5 pt-3 pb-1 text-[13px] leading-[20px]"
    >
      <Show when={props.active}>
        <span
          class="min-w-0 truncate font-medium tracking-[-0.01em] ui-shimmer"
          style={shimmerStyle()}
        >
          {props.statusText}
        </span>
        <Show when={props.listening || Boolean(props.statusMeta)}>
          <span class="inline-flex h-[20px] shrink-0 items-center gap-2 text-xs font-medium text-fg-muted tabular-nums">
            <Show when={props.listening}>
              <span class="rc-voice-live-dot" aria-hidden="true" />
            </Show>
            <Show when={props.statusMeta}>
              <span data-voice-status-meta>{props.statusMeta}</span>
            </Show>
          </span>
        </Show>
      </Show>
    </div>
  );
}

export function VoiceRevealOverlay(props: { reveal: VoiceRevealState | null | undefined }) {
  return (
    <Show when={props.reveal && props.reveal.active ? props.reveal : null}>
      {(r) => (
        <div
          aria-hidden="true"
          data-voice-reveal-overlay
          class="pointer-events-none absolute inset-0 overflow-hidden px-3.5 pt-3 pb-1 text-[13px] leading-[20px] font-normal text-fg"
        >
          <div
            class="whitespace-pre-wrap break-words"
            style={{
              transform: r().scrollTop > 0 ? `translateY(-${r().scrollTop}px)` : undefined,
            }}
          >
            <Show
              when={!reducedMotion()}
              fallback={
                <>
                  {r().prefix}
                  {r().words.join(" ")}
                  {r().suffix}
                </>
              }
            >
              {r().prefix}
              <For each={r().words}>
                {(word, i) => (
                  <>
                    {i() > 0 && !/^\s/.test(word) ? " " : ""}
                    <span
                      class="rc-voice-word-bloom"
                      style={{
                        "animation-delay": `${Math.min(i() * 34, 420)}ms`,
                      }}
                    >
                      {word}
                    </span>
                  </>
                )}
              </For>
              {r().suffix}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}

export function VoiceWaveformIcon(props: { size?: number; class?: string }) {
  const size = () => props.size ?? 16;
  return (
    <svg
      aria-hidden="true"
      width={size()}
      height={size()}
      viewBox="0 0 20 20"
      fill="currentColor"
      class={props.class ? `rc-voice-bars-svg ${props.class}` : "rc-voice-bars-svg"}
    >
      <rect x="2.3" y="8.3" width="1.8" height="3.4" rx="0.9" />
      <rect x="5.7" y="5.8" width="1.8" height="8.4" rx="0.9" />
      <rect x="9.1" y="3.7" width="1.8" height="12.6" rx="0.9" />
      <rect x="12.5" y="6.2" width="1.8" height="7.6" rx="0.9" />
      <rect x="15.9" y="8.3" width="1.8" height="3.4" rx="0.9" />
    </svg>
  );
}
