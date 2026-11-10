import { createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { createGlide } from "../../ds/motion/glide";
import { press } from "../../ds/motion/press";
import { REASONING_LEVELS } from "../constants";
import { formatEffort } from "../utils/format";
import { compactTokens, groupModelsByProvider, type GatewayModel } from "../context";

/** Session choices, also remembered by the daemon for the next draft.
 * (Extracted verbatim from RemoteCodePage.modelPickerBody — narrow props
 * instead of the god-ctx; Phase 3 connects directly to ToolbarModel.) */
export function ModelPickerBody(props: {
  models: () => GatewayModel[];
  filtered: () => GatewayModel[];
  filter: () => string;
  setFilter: (v: string) => void;
  activeModelId: () => string;
  onPick: (id: string) => void;
  effort: () => string;
  onEffort: (lvl: string) => void;
  onRefresh: () => void;
}) {
  /** Filtered models grouped by provider (first routing target). */
  const groups = () => groupModelsByProvider(props.filtered());
  const [effortTrack, setEffortTrack] = createSignal<HTMLDivElement>();
  const [effortInd, setEffortInd] = createSignal<HTMLSpanElement>();
  createGlide({
    container: effortTrack,
    indicator: effortInd,
    target: () => {
      void props.effort();
      return effortTrack()?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null;
    },
  });
  return (
    <>
      <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted flex items-center justify-between">
        <span>Model</span>
        <button
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={props.onRefresh}
          class="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
          data-rc-tip="Refresh models" aria-label="Refresh models"
        >
          <Iconify icon="lucide:refresh-cw" size={11} />
        </button>
      </div>
      <div class="px-2 pb-1.5">
        <div class="rc-studio-well flex items-center gap-1.5 px-2.5 py-1.5 focus-within:border-accent/50 transition-colors">
          <Iconify icon="lucide:search" size={12} class="shrink-0 text-fg-muted" />
          <input
            type="text"
            placeholder="Search models..."
            class="w-full min-w-0 bg-transparent text-xs text-fg placeholder:text-fg-muted focus:outline-none"
            value={props.filter()}
            onInput={(e) => props.setFilter(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            ref={(el) => setTimeout(() => el?.focus(), 40)}
          />
          <Show when={props.filter()}>
            <button
              type="button"
              aria-label="Clear model filter"
              onClick={(e) => {
                e.stopPropagation();
                props.setFilter("");
              }}
              class="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg hover:bg-surface-muted cursor-pointer"
            >
              <Iconify icon="lucide:x" size={11} />
            </button>
          </Show>
        </div>
      </div>
      <div class="max-h-60 overflow-y-auto overflow-x-hidden px-1 pb-1 [scrollbar-gutter:stable]">
        <div class="flex flex-col space-y-0.5">
          <For
            each={groups()}
            fallback={
              <div class="px-2.5 py-3 text-xs text-fg-muted text-center">
                {props.models().length ? "No models match." : "No compatible models configured in the gateway."}
              </div>
            }
          >
            {(g) => (
              <>
                <div class="px-2 pt-2 pb-0.5 text-[11px] font-medium text-fg-muted flex items-center gap-1.5">
                  <span class="truncate">{g.provider}</span>
                  <span class="h-px flex-1 bg-border/60" />
                </div>
                <For each={g.models}>
                  {(m) => {
                    const active = () => m.id === props.activeModelId();
                    return (
                      <button
                        onPointerDown={(e) => press(e.currentTarget)}
                        onClick={() => props.onPick(m.id)}
                        class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                          active()
                            ? "bg-accent-subtle text-fg font-medium"
                            : "text-fg-secondary hover:text-fg hover:bg-surface-muted"
                        }`}
                      >
                        <span class="min-w-0 flex-1 truncate">
                          <span>{m.name || m.id}</span>
                          <Show when={m.upstreamModel && m.upstreamModel !== (m.name || m.id)}>
                            <span class="text-fg-muted"> ({m.upstreamModel})</span>
                          </Show>
                        </span>
                        <span class="shrink-0 flex items-center gap-1.5">
                          <Show when={(m.context ?? 0) > 0}>
                            <span class="rounded border border-border/70 bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] text-fg-muted tabular-nums">
                              {compactTokens(m.context ?? 0)}
                            </span>
                          </Show>
                          <Show when={active()}>
                            <Iconify icon="lucide:check" size={13} class="shrink-0 text-accent" />
                          </Show>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
      <div class="mt-1.5 pt-1.5 border-t border-border/70">
        <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">
          Reasoning effort
        </div>
        <div
          ref={setEffortTrack}
          data-glide=""
          class="ui-segmented ui-segmented-sm grid grid-cols-7 gap-0.5 p-1"
          role="group"
          aria-label="Reasoning effort"
        >
          <span ref={setEffortInd} class="ui-segmented-indicator" aria-hidden="true" />
          <For each={REASONING_LEVELS}>
            {(lvl) => (
              <button
                type="button"
                aria-pressed={props.effort() === lvl}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => props.onEffort(lvl)}
                class={`ui-segment py-1 rounded-md text-center text-[10px] sm:text-[11px] font-medium cursor-pointer ${
                  props.effort() === lvl
                    ? "text-fg"
                    : "text-fg-muted hover:text-fg-secondary"
                }`}
              >
                {formatEffort(lvl)}
              </button>
            )}
          </For>
        </div>
      </div>

    </>
  );
}
