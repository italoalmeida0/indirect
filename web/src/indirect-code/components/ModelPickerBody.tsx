import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { reducedMotion } from "../../ds/motion/reduced";
import { compactTokens, groupModelsByProvider, type GatewayModel } from "../context";

export const PROVIDER_SCROLL_EPSILON = 1.5;
export const PROVIDER_HOLD_DELAY_MS = 160;

export function computeProviderScrollBounds(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
  epsilon = PROVIDER_SCROLL_EPSILON,
): { canScrollLeft: boolean; canScrollRight: boolean } {
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  if (maxScroll <= epsilon) {
    return { canScrollLeft: false, canScrollRight: false };
  }
  return {
    canScrollLeft: scrollLeft > epsilon,
    canScrollRight: scrollLeft + clientWidth < scrollWidth - epsilon,
  };
}

export function computeProviderStepPx(clientWidth: number): number {
  return Math.max(120, Math.round(clientWidth * 0.64));
}

export function translateProviderWheelDelta(params: {
  deltaX: number;
  deltaY: number;
  ctrlKey?: boolean;
  clientWidth: number;
  scrollWidth: number;
}): number | null {
  if (params.ctrlKey) return null;
  if (params.scrollWidth <= params.clientWidth + PROVIDER_SCROLL_EPSILON) return null;
  if (Math.abs(params.deltaY) <= Math.abs(params.deltaX) || params.deltaY === 0) return null;
  return params.deltaY;
}

export interface ProviderHoldTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout>) => void;
  requestAnimationFrame: (cb: (now: number) => void) => number;
  cancelAnimationFrame: (id: number) => void;
  now?: () => number;
}

export function createProviderHoldScroller(opts: {
  getStrip: () => { scrollLeft: number; clientWidth: number; scrollWidth: number } | undefined;
  onScrollUpdate: () => void;
  holdDelayMs?: number;
  minSpeedPxPerSec?: number;
  maxSpeedPxPerSec?: number;
  rampSec?: number;
  timers?: ProviderHoldTimers;
}) {
  const holdDelayMs = opts.holdDelayMs ?? PROVIDER_HOLD_DELAY_MS;
  const minSpeed = opts.minSpeedPxPerSec ?? 260;
  const maxSpeed = opts.maxSpeedPxPerSec ?? 380;
  const rampSec = opts.rampSec ?? 0.6;
  const timers: ProviderHoldTimers = opts.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
    cancelAnimationFrame: (id) => globalThis.cancelAnimationFrame(id),
    now: () => performance.now(),
  };
  const readNow = () => (timers.now ? timers.now() : performance.now());

  let activeDir: -1 | 1 | 0 = 0;
  let timerId: ReturnType<typeof globalThis.setTimeout> | null = null;
  let rafId: number | null = null;
  let heldDuringCurrentPress = false;
  let suppressClickUntil = 0;

  const clearScheduled = () => {
    if (timerId !== null) {
      timers.clearTimeout(timerId);
      timerId = null;
    }
    if (rafId !== null) {
      timers.cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const stop = () => {
    if (activeDir !== 0 && heldDuringCurrentPress) {
      suppressClickUntil = readNow() + 350;
    }
    activeDir = 0;
    clearScheduled();
  };

  const start = (dir: -1 | 1): boolean => {
    const strip = opts.getStrip();
    if (!strip) return false;
    const bounds = computeProviderScrollBounds(strip.scrollLeft, strip.clientWidth, strip.scrollWidth);
    if (dir < 0 ? !bounds.canScrollLeft : !bounds.canScrollRight) return false;

    stop();
    activeDir = dir;
    heldDuringCurrentPress = false;
    suppressClickUntil = 0;

    timerId = timers.setTimeout(() => {
      timerId = null;
      if (activeDir !== dir) return;
      const initialStrip = opts.getStrip();
      if (!initialStrip) {
        stop();
        return;
      }

      heldDuringCurrentPress = true;
      suppressClickUntil = readNow() + 350;
      let startTs: number | null = null;
      let lastTs: number | null = null;
      let subpixelCarry = 0;

      const stepFrame = (now: number) => {
        if (activeDir !== dir) {
          rafId = null;
          return;
        }
        const s = opts.getStrip();
        if (!s) {
          stop();
          return;
        }

        suppressClickUntil = readNow() + 350;
        if (startTs === null || lastTs === null) {
          startTs = now;
          lastTs = now;
          subpixelCarry += dir * (minSpeed * (1 / 30));
        } else {
          const dt = Math.min(0.064, Math.max(0, (now - lastTs) / 1000));
          lastTs = now;
          const elapsed = Math.max(0, (now - startTs) / 1000);
          const progress = rampSec > 0 ? Math.min(1, elapsed / rampSec) : 1;
          const eased = 1 - (1 - progress) * (1 - progress);
          const speed = minSpeed + (maxSpeed - minSpeed) * eased;
          subpixelCarry += dir * speed * dt;
        }

        const wholePx = subpixelCarry > 0 ? Math.floor(subpixelCarry) : Math.ceil(subpixelCarry);
        if (wholePx !== 0) {
          subpixelCarry -= wholePx;
          const maxScroll = Math.max(0, s.scrollWidth - s.clientWidth);
          const next = Math.min(maxScroll, Math.max(0, s.scrollLeft + wholePx));
          s.scrollLeft = next;
          opts.onScrollUpdate();

          const nextBounds = computeProviderScrollBounds(s.scrollLeft, s.clientWidth, s.scrollWidth);
          if (dir < 0 ? !nextBounds.canScrollLeft : !nextBounds.canScrollRight) {
            const exactEdge = dir < 0 ? 0 : maxScroll;
            if (s.scrollLeft !== exactEdge) {
              s.scrollLeft = exactEdge;
              opts.onScrollUpdate();
            }
            stop();
            return;
          }
        }

        rafId = timers.requestAnimationFrame(stepFrame);
      };

      rafId = timers.requestAnimationFrame(stepFrame);
    }, holdDelayMs);

    return true;
  };

  const consumeClickSuppression = (): boolean => {
    if (suppressClickUntil <= 0) return false;
    const active = readNow() <= suppressClickUntil;
    suppressClickUntil = 0;
    return active;
  };

  return {
    start,
    stop,
    dispose: stop,
    isHolding: () => activeDir !== 0,
    didHold: () => heldDuringCurrentPress,
    consumeClickSuppression,
  };
}

/** Session choices, also remembered by the daemon for the next draft. */
export function ModelPickerBody(props: {
  models: () => GatewayModel[];
  filtered: () => GatewayModel[];
  filter: () => string;
  setFilter: (v: string) => void;
  activeModelId: () => string;
  onPick: (id: string) => void;
  onRefresh: () => void;
  onBackToEffort?: () => void;
}) {
  const [selectedProvider, setSelectedProvider] = createSignal<string>("all");
  const [highlightedId, setHighlightedId] = createSignal<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = createSignal(false);
  const [canScrollRight, setCanScrollRight] = createSignal(false);
  let listRef: HTMLDivElement | undefined;
  let providerStripRef: HTMLDivElement | undefined;
  let providerContentRef: HTMLDivElement | undefined;

  const updateScrollBounds = () => {
    const el = providerStripRef;
    if (!el) {
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    const next = computeProviderScrollBounds(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setCanScrollLeft(next.canScrollLeft);
    setCanScrollRight(next.canScrollRight);
  };

  const holdScroller = createProviderHoldScroller({
    getStrip: () => providerStripRef,
    onScrollUpdate: updateScrollBounds,
  });

  if (typeof window !== "undefined") {
    const endHold = () => holdScroller.stop();
    window.addEventListener("pointerup", endHold, true);
    window.addEventListener("pointercancel", endHold, true);
    window.addEventListener("blur", endHold);
    onCleanup(() => {
      window.removeEventListener("pointerup", endHold, true);
      window.removeEventListener("pointercancel", endHold, true);
      window.removeEventListener("blur", endHold);
      holdScroller.dispose();
    });
  } else {
    onCleanup(() => holdScroller.dispose());
  }

  const stepProviderScroll = (dir: -1 | 1) => {
    const strip = providerStripRef;
    if (!strip) return;
    const step = computeProviderStepPx(strip.clientWidth);
    strip.scrollBy({
      left: dir * step,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    updateScrollBounds();
  };

  const handleArrowPointerDown = (
    dir: -1 | 1,
    e: PointerEvent & { currentTarget: HTMLButtonElement },
  ) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    if (!holdScroller.start(dir)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
  };

  const handleProviderWheel = (e: WheelEvent) => {
    const strip = providerStripRef;
    if (!strip) return;
    const delta = translateProviderWheelDelta({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      ctrlKey: e.ctrlKey,
      clientWidth: strip.clientWidth,
      scrollWidth: strip.scrollWidth,
    });
    if (delta === null) return;
    e.preventDefault();
    e.stopPropagation();
    strip.scrollLeft += delta;
    updateScrollBounds();
  };

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

  createEffect(() => {
    const multi = hasMultipleProviders();
    void allProviderGroups().length;
    void props.models().length;
    if (!multi) {
      holdScroller.stop();
      setCanScrollLeft(false);
      setCanScrollRight(false);
      return;
    }
    updateScrollBounds();
    if (typeof requestAnimationFrame === "function") {
      const id = requestAnimationFrame(() => updateScrollBounds());
      onCleanup(() => cancelAnimationFrame(id));
    }
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

  return (
    <>
      <div class="-mx-1.5 -mt-1.5 flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
        <Show when={props.onBackToEffort}>
          <button
            type="button"
            aria-label="Back to effort"
            data-rc-tip="Back to effort"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={(e) => {
              e.stopPropagation();
              props.onBackToEffort?.();
            }}
            class="ui-icon-button ui-icon-button-xs shrink-0 -ml-1 text-fg-muted"
          >
            <Iconify icon="lucide:arrow-left" size={13} />
          </button>
          <span class="h-3.5 w-px bg-border-subtle shrink-0" aria-hidden="true" />
        </Show>
        <Iconify icon="lucide:search" size={13} class="shrink-0 text-fg-muted" />
        <input
          type="text"
          aria-label="Search models"
          placeholder="Search models…"
          class="flex-1 min-w-0 bg-transparent text-xs max-sm:text-base text-fg placeholder:text-fg-muted focus:outline-none"
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
            data-rc-tip="Clear search"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              props.setFilter("");
            }}
            class="ui-icon-button ui-icon-button-xs shrink-0 text-fg-muted"
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
          class="ui-icon-button ui-icon-button-xs shrink-0 -mr-1 text-fg-muted"
          data-rc-tip="Refresh models"
          aria-label="Refresh models"
        >
          <Iconify icon="lucide:refresh-cw" size={12} />
        </button>
      </div>

      <Show when={hasMultipleProviders()}>
        <div class="-mx-1.5 relative border-b border-border-subtle">
          <div
            ref={(el) => {
              providerStripRef = el;
              updateScrollBounds();
              let rafId: number | null =
                typeof requestAnimationFrame === "function"
                  ? requestAnimationFrame(() => {
                      rafId = null;
                      updateScrollBounds();
                    })
                  : null;
              const ro =
                typeof ResizeObserver !== "undefined"
                  ? new ResizeObserver(() => updateScrollBounds())
                  : null;
              ro?.observe(el);
              if (el.firstElementChild) ro?.observe(el.firstElementChild);
              queueMicrotask(() => {
                if (providerContentRef && providerContentRef !== el.firstElementChild) {
                  ro?.observe(providerContentRef);
                }
                updateScrollBounds();
              });
              onCleanup(() => {
                if (rafId !== null && typeof cancelAnimationFrame === "function") {
                  cancelAnimationFrame(rafId);
                }
                ro?.disconnect();
                holdScroller.stop();
                if (providerStripRef === el) providerStripRef = undefined;
              });
            }}
            role="toolbar"
            aria-label="Filter by provider"
            onScroll={updateScrollBounds}
            onWheel={handleProviderWheel}
            class="overflow-x-auto no-scrollbar scroll-auto scroll-px-9"
          >
            <div
              ref={(el) => {
                providerContentRef = el;
                onCleanup(() => {
                  if (providerContentRef === el) providerContentRef = undefined;
                });
              }}
              class="flex w-max items-center gap-1 px-3 py-1.5"
            >
              <button
                type="button"
                aria-pressed={effectiveProvider() === "all"}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={(e) => {
                  setSelectedProvider("all");
                  e.currentTarget.scrollIntoView?.({
                    block: "nearest",
                    inline: "nearest",
                    behavior: reducedMotion() ? "auto" : "smooth",
                  });
                }}
                class={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 min-h-6 [@media(pointer:coarse)]:min-h-8 text-2xs font-medium transition-colors cursor-pointer ${
                  effectiveProvider() === "all"
                    ? "border-accent/35 bg-accent-subtle text-fg"
                    : "border-border bg-surface-subtle text-fg-muted hover:text-fg hover:bg-surface-muted"
                }`}
              >
                <span>All</span>
                <span class={`font-mono text-2xs tabular-nums ${effectiveProvider() === "all" ? "text-accent" : "text-fg-muted"}`}>
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
                      onClick={(e) => {
                        setSelectedProvider(activeChip() ? "all" : g.provider);
                        e.currentTarget.scrollIntoView?.({
                          block: "nearest",
                          inline: "nearest",
                          behavior: reducedMotion() ? "auto" : "smooth",
                        });
                      }}
                      class={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 min-h-6 [@media(pointer:coarse)]:min-h-8 text-2xs font-medium transition-colors cursor-pointer ${
                        activeChip()
                          ? "border-accent/35 bg-accent-subtle text-fg"
                          : "border-border bg-surface-subtle text-fg-muted hover:text-fg hover:bg-surface-muted"
                      }`}
                    >
                      <span class="max-w-[110px] truncate">{g.provider}</span>
                      <span class={`font-mono text-2xs tabular-nums ${activeChip() ? "text-accent" : "text-fg-muted"}`}>
                        {g.models.length}
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>

          <Show when={canScrollLeft() || canScrollRight()}>
            <div
              data-provider-scroll-edge="left"
              aria-hidden={!canScrollLeft() ? "true" : undefined}
              class={`absolute inset-y-0 left-0 z-10 flex items-center pl-1.5 pr-5 pointer-events-none transition-opacity duration-150 ${
                canScrollLeft() ? "opacity-100" : "opacity-0"
              }`}
              style={{
                background: "linear-gradient(90deg, var(--surface-raised) 56%, transparent 100%)",
              }}
            >
              <button
                type="button"
                aria-label="Scroll providers left"
                data-rc-tip="Scroll providers left"
                disabled={!canScrollLeft()}
                tabIndex={canScrollLeft() ? 0 : -1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onPointerDown={(e) => handleArrowPointerDown(-1, e)}
                onPointerUp={() => holdScroller.stop()}
                onPointerCancel={() => holdScroller.stop()}
                onLostPointerCapture={() => holdScroller.stop()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (holdScroller.consumeClickSuppression()) {
                    e.preventDefault();
                    return;
                  }
                  stepProviderScroll(-1);
                }}
                class={`relative h-6 w-6 rounded-full border border-border bg-surface-subtle hover:bg-surface-muted hover:border-border-strong active:scale-95 text-fg-secondary hover:text-fg flex items-center justify-center transition-[color,background-color,border-color,transform] duration-100 cursor-pointer [@media(pointer:coarse)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-11 [@media(pointer:coarse)]:after:-translate-1/2 ${
                  canScrollLeft() ? "pointer-events-auto" : "pointer-events-none"
                }`}
              >
                <Iconify icon="lucide:chevron-left" size={13} />
              </button>
            </div>

            <div
              data-provider-scroll-edge="right"
              aria-hidden={!canScrollRight() ? "true" : undefined}
              class={`absolute inset-y-0 right-0 z-10 flex items-center pr-1.5 pl-5 pointer-events-none transition-opacity duration-150 ${
                canScrollRight() ? "opacity-100" : "opacity-0"
              }`}
              style={{
                background: "linear-gradient(270deg, var(--surface-raised) 56%, transparent 100%)",
              }}
            >
              <button
                type="button"
                aria-label="Scroll providers right"
                data-rc-tip="Scroll providers right"
                disabled={!canScrollRight()}
                tabIndex={canScrollRight() ? 0 : -1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onPointerDown={(e) => handleArrowPointerDown(1, e)}
                onPointerUp={() => holdScroller.stop()}
                onPointerCancel={() => holdScroller.stop()}
                onLostPointerCapture={() => holdScroller.stop()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (holdScroller.consumeClickSuppression()) {
                    e.preventDefault();
                    return;
                  }
                  stepProviderScroll(1);
                }}
                class={`relative h-6 w-6 rounded-full border border-border bg-surface-subtle hover:bg-surface-muted hover:border-border-strong active:scale-95 text-fg-secondary hover:text-fg flex items-center justify-center transition-[color,background-color,border-color,transform] duration-100 cursor-pointer [@media(pointer:coarse)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-11 [@media(pointer:coarse)]:after:-translate-1/2 ${
                  canScrollRight() ? "pointer-events-auto" : "pointer-events-none"
                }`}
              >
                <Iconify icon="lucide:chevron-right" size={13} />
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <div ref={listRef} class="max-h-60 overflow-y-auto overflow-x-hidden overscroll-contain pt-1 pb-0.5">
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
                  <div class="px-2.5 pt-1.5 pb-1 text-2xs font-mono font-medium text-fg-muted flex items-center gap-2">
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
                          class={`ui-menu-item w-full text-left px-2.5 py-1.5 min-h-9 [@media(pointer:coarse)]:min-h-11 rounded-lg flex items-center justify-between gap-3 cursor-pointer transition-colors ${
                            active()
                              ? "bg-accent-subtle text-fg"
                              : highlighted()
                              ? "bg-surface-muted text-fg"
                              : "text-fg-secondary hover:text-fg hover:bg-surface-muted"
                          }`}
                        >
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm font-medium leading-snug text-fg">
                              {primaryName()}
                            </span>
                            <Show when={secondarySlug()}>
                              <span class="block truncate text-2xs font-mono text-fg-muted leading-tight mt-0.5">
                                {secondarySlug()}
                              </span>
                            </Show>
                          </span>
                          <span class="shrink-0 flex items-center gap-2">
                            <Show when={(m.context ?? 0) > 0}>
                              <span class="font-mono text-2xs text-fg-muted tabular-nums">
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
    </>
  );
}
