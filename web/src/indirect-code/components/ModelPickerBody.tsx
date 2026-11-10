import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { createGlide } from "../../ds/motion/glide";
import { press } from "../../ds/motion/press";
import { REASONING_LEVELS } from "../constants";
import { formatEffort } from "../utils/format";
import { compactTokens, groupModelsByProvider, type GatewayModel } from "../context";

function effortDepth(raw: string): number {
  switch ((raw || "").trim().toLowerCase()) {
    case "none":
    case "off":
      return 0;
    case "minimum":
    case "min":
      return 1;
    case "low":
      return 2;
    case "medium":
    case "med":
    case "medi":
      return 3;
    case "high":
      return 4;
    case "xhigh":
    case "max":
      return 5;
    default:
      return 3;
  }
}

/** Session choices, also remembered by the daemon for the next draft. */
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
  const [selectedProvider, setSelectedProvider] = createSignal<string>("all");
  const [highlightedId, setHighlightedId] = createSignal<string | null>(null);
  const [effortTrack, setEffortTrack] = createSignal<HTMLDivElement>();
  const [effortInd, setEffortInd] = createSignal<HTMLSpanElement>();
  let listRef: HTMLDivElement | undefined;

  const scrollModelIntoView = (id: string) => {
    queueMicrotask(() => {
      if (!listRef) return;
      const rows = listRef.querySelectorAll<HTMLElement>("[data-model-row]");
      for (const row of Array.from(rows)) {
        if (row.dataset.modelRow === id) {
          row.scrollIntoView({ block: "nearest" });
          break;
        }
      }
    });
  };

  const allProviderGroups = createMemo(() => groupModelsByProvider(props.models()));
  const hasMultipleProviders = createMemo(() => allProviderGroups().length >= 2);
  const effectiveProvider = createMemo(() => {
    const picked = selectedProvider();
    if (picked === "all") return "all";
    return allProviderGroups().some((g) => g.provider === picked) ? picked : "all";
  });

  /** Filtered models grouped by provider (first routing target), narrowed by provider chip. */
  const groups = createMemo(() => {
    const base = groupModelsByProvider(props.filtered());
    const prov = effectiveProvider();
    return prov === "all" ? base : base.filter((g) => g.provider === prov);
  });

  const flatVisibleModels = createMemo(() => groups().flatMap((g) => g.models));

  const effectiveHighlightedId = createMemo(() => {
    const list = flatVisibleModels();
    if (list.length === 0) return null;
    const cur = highlightedId();
    if (cur && list.some((m) => m.id === cur)) return cur;
    const active = props.activeModelId();
    if (active && list.some((m) => m.id === active)) return active;
    return list[0]!.id;
  });

  const activeBars = createMemo(() => effortDepth(props.effort()));

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
      <div class="flex items-center gap-2 px-2.5 py-1.5 border-b border-border-subtle">
        <Iconify icon="lucide:search" size={13} class="shrink-0 text-fg-muted" />
        <input
          type="text"
          aria-label="Search models"
          placeholder="Search models…"
          class="flex-1 min-w-0 bg-transparent text-xs text-fg placeholder:text-fg-muted focus:outline-none"
          value={props.filter()}
          onInput={(e) => props.setFilter(e.currentTarget.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.isComposing) {
              e.stopPropagation();
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
              e.preventDefault();
              e.stopPropagation();
              const list = flatVisibleModels();
              if (list.length === 0) return;
              const curId = effectiveHighlightedId();
              const idx = curId ? list.findIndex((m) => m.id === curId) : -1;
              let nextIdx = 0;
              if (e.key === "Home") nextIdx = 0;
              else if (e.key === "End") nextIdx = list.length - 1;
              else if (e.key === "ArrowDown") nextIdx = idx < list.length - 1 ? idx + 1 : 0;
              else if (e.key === "ArrowUp") nextIdx = idx > 0 ? idx - 1 : list.length - 1;
              const next = list[nextIdx];
              if (next) {
                setHighlightedId(next.id);
                scrollModelIntoView(next.id);
              }
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              const targetId = effectiveHighlightedId();
              if (targetId) props.onPick(targetId);
              return;
            }
            if (e.key === "Escape" && props.filter()) {
              e.preventDefault();
              e.stopPropagation();
              props.setFilter("");
              return;
            }
            if (e.key !== "Escape") {
              e.stopPropagation();
            }
          }}
          ref={(el) => setTimeout(() => el?.focus(), 40)}
        />
        <Show when={props.filter()}>
          <button
            type="button"
            aria-label="Clear model filter"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              props.setFilter("");
            }}
            class="shrink-0 rounded p-0.5 text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
          >
            <Iconify icon="lucide:x" size={12} />
          </button>
        </Show>
        <span class="h-3.5 w-px bg-border-subtle shrink-0" aria-hidden="true" />
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={props.onRefresh}
          class="shrink-0 p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
          data-rc-tip="Refresh models"
          aria-label="Refresh models"
        >
          <Iconify icon="lucide:refresh-cw" size={12} />
        </button>
      </div>

      <Show when={hasMultipleProviders()}>
        <div
          role="toolbar"
          aria-label="Filter by provider"
          class="flex items-center gap-1 px-2 py-1.5 border-b border-border-subtle overflow-x-auto no-scrollbar"
        >
          <button
            type="button"
            aria-pressed={effectiveProvider() === "all"}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => setSelectedProvider("all")}
            class={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
              effectiveProvider() === "all"
                ? "border-accent/35 bg-accent-subtle text-fg"
                : "border-border/80 bg-surface-subtle text-fg-muted hover:text-fg hover:bg-surface-muted"
            }`}
          >
            <span>All</span>
            <span class={`font-mono text-[10px] tabular-nums ${effectiveProvider() === "all" ? "text-accent" : "text-fg-muted"}`}>
              {props.models().length}
            </span>
          </button>
          <For each={allProviderGroups()}>
            {(g) => {
              const activeChip = () => effectiveProvider() === g.provider;
              return (
                <button
                  type="button"
                  aria-pressed={activeChip()}
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => setSelectedProvider(activeChip() ? "all" : g.provider)}
                  class={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer ${
                    activeChip()
                      ? "border-accent/35 bg-accent-subtle text-fg"
                      : "border-border/80 bg-surface-subtle text-fg-muted hover:text-fg hover:bg-surface-muted"
                  }`}
                >
                  <span class="max-w-[110px] truncate">{g.provider}</span>
                  <span class={`font-mono text-[10px] tabular-nums ${activeChip() ? "text-accent" : "text-fg-muted"}`}>
                    {g.models.length}
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <div ref={listRef} class="max-h-60 overflow-y-auto overflow-x-hidden px-1 py-1 [scrollbar-gutter:stable]">
        <div class="flex flex-col space-y-0.5">
          <For
            each={groups()}
            fallback={
              <div class="px-2.5 py-4 text-xs text-fg-muted text-center">
                {props.models().length ? "No models match." : "No compatible models configured in the gateway."}
              </div>
            }
          >
            {(g) => (
              <div>
                <Show when={effectiveProvider() === "all"}>
                  <div class="px-2 pt-1.5 pb-0.5 text-[10px] font-mono font-medium text-fg-muted flex items-center gap-2">
                    <span class="truncate">{g.provider}</span>
                    <span class="h-px flex-1 bg-border-subtle" />
                  </div>
                </Show>
                <div class="space-y-0.5">
                  <For each={g.models}>
                    {(m) => {
                      const active = () => m.id === props.activeModelId();
                      const highlighted = () => m.id === effectiveHighlightedId();
                      const primaryName = () => m.name || m.id;
                      const secondarySlug = () => {
                        const primary = primaryName();
                        if (m.upstreamModel && m.upstreamModel !== primary) return m.upstreamModel;
                        if (m.id && m.id !== primary) return m.id;
                        return "";
                      };
                      return (
                        <button
                          type="button"
                          data-model-row={m.id}
                          data-highlighted={highlighted() ? "1" : undefined}
                          onPointerEnter={() => setHighlightedId(m.id)}
                          onPointerDown={(e) => press(e.currentTarget)}
                          onClick={() => props.onPick(m.id)}
                          class={`w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                            active()
                              ? "bg-accent-subtle text-fg"
                              : highlighted()
                              ? "bg-surface-muted text-fg"
                              : "text-fg-secondary hover:text-fg hover:bg-surface-muted"
                          }`}
                        >
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-[13px] font-medium leading-snug text-fg">
                              {primaryName()}
                            </span>
                            <Show when={secondarySlug()}>
                              <span class="block truncate text-[11px] font-mono text-fg-muted leading-tight mt-0.5">
                                {secondarySlug()}
                              </span>
                            </Show>
                          </span>
                          <span class="shrink-0 flex items-center gap-2">
                            <Show when={(m.context ?? 0) > 0}>
                              <span class="font-mono text-[11px] text-fg-muted tabular-nums">
                                {compactTokens(m.context ?? 0)}
                              </span>
                            </Show>
                            <span class="w-3.5 flex items-center justify-end shrink-0">
                              <Show when={active()}>
                                <Iconify icon="lucide:check" size={13} class="shrink-0 text-accent" />
                              </Show>
                            </span>
                          </span>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="pt-1.5 pb-0.5 px-1 border-t border-border-subtle">
        <div class="px-1.5 pb-1.5 flex items-center justify-between gap-2">
          <span class="text-[11px] font-medium text-fg-muted">Reasoning effort</span>
          <span class="inline-flex items-center gap-2" aria-hidden="true">
            <span class="inline-flex items-end gap-[2px] h-3.5" data-effort-meter={activeBars()}>
              <For each={[1, 2, 3, 4, 5]}>
                {(bar) => (
                  <span
                    class={`w-[2.5px] rounded-full transition-colors duration-150 ${
                      bar <= activeBars()
                        ? props.effort().toLowerCase() === "max"
                          ? "bg-warning"
                          : "bg-accent"
                        : "bg-border-strong/50"
                    }`}
                    style={{ height: `${4 + bar * 2}px` }}
                  />
                )}
              </For>
            </span>
            <span class="font-mono text-[10px] font-medium text-fg-secondary tabular-nums min-w-[2.25rem] text-right">
              {formatEffort(props.effort()) || "MED"}
            </span>
          </span>
        </div>
        <div
          ref={setEffortTrack}
          data-glide=""
          class="ui-segmented ui-segmented-sm grid grid-cols-7 gap-0.5 p-0.5 w-full"
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
                class={`ui-segment px-0.5 py-1 rounded-md text-center font-mono text-[10px] font-medium cursor-pointer ${
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
