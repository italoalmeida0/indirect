import type { Placement } from "@floating-ui/dom";

export const TOOLTIP_COLD_DELAY_MS = 500;
export const TOOLTIP_WARM_COOLDOWN_MS = 500;
export const TOOLTIP_ANCHOR_ATTR = "data-tooltip-anchor";
export const DELEGATED_TIP_SELECTOR = "[data-rc-tip], [data-tip]";

const ANY_TRIGGER_SELECTOR = `[data-rc-tip], [data-tip], [${TOOLTIP_ANCHOR_ATTR}]`;
const INTERACTIVE_SELECTOR =
  'button, a, summary, input, select, textarea, [role="button"], [role="combobox"], [role="menuitem"], [role="tab"], [role="option"], [role="switch"]';

const VALID_PLACEMENTS = new Set<Placement>([
  "top",
  "top-start",
  "top-end",
  "bottom",
  "bottom-start",
  "bottom-end",
  "left",
  "left-start",
  "left-end",
  "right",
  "right-start",
  "right-end",
]);

export interface TooltipSessionTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setTimeout>;
  clearTimeout: (id: ReturnType<typeof globalThis.setTimeout> | undefined) => void;
}

export interface TooltipEntry {
  /** Unique key per tooltip owner or trigger element. */
  key: unknown;
  /** DOM element of the trigger (used for suppression and containment checks). */
  trigger: Element | null;
  /** Opens the tooltip (`instant` is false on cold hover, true when session is warm). */
  open: (instant: boolean) => void;
  /** Closes the tooltip immediately. */
  close: () => void;
}

export interface TooltipSessionOptions {
  coldDelayMs?: number;
  warmCooldownMs?: number;
  timers?: TooltipSessionTimers;
}

export interface TooltipSession {
  isWarm: () => boolean;
  activeKey: () => unknown;
  suppressedElement: () => Element | null;
  enter: (entry: TooltipEntry, delayMs?: number) => void;
  focus: (entry: TooltipEntry) => void;
  leave: (key: unknown) => void;
  dismissKey: (key: unknown) => void;
  dismissTransient: () => void;
  hardReset: (trigger?: Element | null) => void;
  notifyPointerOut: (target: unknown, relatedTarget: unknown) => void;
  notifyPointerOver: (target: unknown) => void;
  retainGlobalListeners: () => () => void;
  setTimers: (timers?: TooltipSessionTimers) => void;
}

const defaultTimers: TooltipSessionTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => {
    if (id !== undefined) globalThis.clearTimeout(id);
  },
};

export function isElementLike(value: unknown): value is Element {
  if (!value || typeof value !== "object") return false;
  if (typeof Element !== "undefined") return value instanceof Element;
  return (value as Node).nodeType === 1 || typeof (value as Element).getAttribute === "function";
}

export function isNodeLike(value: unknown): value is Node {
  if (!value || typeof value !== "object") return false;
  if (typeof Node !== "undefined") return value instanceof Node;
  return typeof (value as Node).nodeType === "number" || isElementLike(value);
}

function containsNode(container: Element, candidate: unknown): boolean {
  if (!isNodeLike(candidate)) return false;
  if ((container as unknown) === candidate) return true;
  return typeof container.contains === "function" ? container.contains(candidate) : false;
}

/** Single source of truth matching pre-paint `html.mobile` in `web/index.html`. */
export function isMobileTooltipEnvironment(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.documentElement?.classList?.contains("mobile"));
}

export function isFocusVisibleTarget(el: Element | null): boolean {
  if (!el || typeof el.matches !== "function") return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function getDelegatedTooltipText(el: Element | null): string {
  if (!el) return "";
  const raw = el.getAttribute("data-rc-tip") ?? el.getAttribute("data-tip") ?? "";
  return raw.trim();
}

export function resolveTooltipPlacement(el: Element | null): Placement {
  if (!el) return "top";
  const raw = (
    el.getAttribute("data-rc-tip-placement") ??
    el.getAttribute("data-tip-placement") ??
    ""
  ).trim() as Placement;
  return VALID_PLACEMENTS.has(raw) ? raw : "top";
}

function hasBusyAttribute(el: Element): boolean {
  if (el.getAttribute("aria-expanded") === "true") return true;
  if (el.hasAttribute("data-tip-busy") && el.getAttribute("data-tip-busy") !== "false") return true;
  return false;
}

/**
 * Returns `true` when `el` (or its interactive control / `<Tooltip>` child trigger)
 * has an open menu (`aria-expanded="true"`), explicit `data-tip-busy`, or empty tooltip text.
 */
export function isTooltipSuppressedTarget(el: Element | null): boolean {
  if (!el) return true;

  const stopInteractive =
    typeof el.closest === "function" ? el.closest(INTERACTIVE_SELECTOR) : null;
  const stopTrigger =
    typeof el.closest === "function" ? el.closest(ANY_TRIGGER_SELECTOR) : null;

  let cur: Element | null = el;
  let passedTrigger = stopTrigger === null;
  let passedInteractive = stopInteractive === null;
  while (cur) {
    if (hasBusyAttribute(cur)) return true;
    if (cur === stopTrigger) passedTrigger = true;
    if (cur === stopInteractive) passedInteractive = true;
    if (passedTrigger && passedInteractive) break;
    cur = cur.parentElement;
  }

  const anchorRoot = el.hasAttribute(TOOLTIP_ANCHOR_ATTR)
    ? el
    : typeof el.closest === "function"
      ? el.closest(`[${TOOLTIP_ANCHOR_ATTR}]`)
      : null;
  if (anchorRoot && typeof anchorRoot.querySelector === "function") {
    const busyChild = anchorRoot.querySelector(
      '[aria-expanded="true"], [data-tip-busy]:not([data-tip-busy="false"])',
    );
    if (busyChild) return true;
  }

  const tipCarrier =
    el.hasAttribute("data-rc-tip") || el.hasAttribute("data-tip")
      ? el
      : typeof el.closest === "function"
        ? el.closest(DELEGATED_TIP_SELECTOR)
        : null;
  if (tipCarrier) {
    return getDelegatedTooltipText(tipCarrier).length === 0;
  }
  if (anchorRoot) {
    return false;
  }
  return true;
}

export function createTooltipSession(opts: TooltipSessionOptions = {}): TooltipSession {
  const coldDelayMs = opts.coldDelayMs ?? TOOLTIP_COLD_DELAY_MS;
  const warmCooldownMs = opts.warmCooldownMs ?? TOOLTIP_WARM_COOLDOWN_MS;
  let timers: TooltipSessionTimers = opts.timers ?? defaultTimers;

  let warm = false;
  let pendingEntry: TooltipEntry | null = null;
  let activeEntry: TooltipEntry | null = null;
  let suppressedEl: Element | null = null;
  let showTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let cooldownTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

  let listenerRefs = 0;
  let detachGlobal: (() => void) | null = null;

  const clearShowTimer = () => {
    if (showTimer !== undefined) {
      timers.clearTimeout(showTimer);
      showTimer = undefined;
    }
    pendingEntry = null;
  };

  const clearCooldownTimer = () => {
    if (cooldownTimer !== undefined) {
      timers.clearTimeout(cooldownTimer);
      cooldownTimer = undefined;
    }
  };

  const startCooldown = () => {
    clearCooldownTimer();
    cooldownTimer = timers.setTimeout(() => {
      cooldownTimer = undefined;
      warm = false;
    }, warmCooldownMs);
  };

  const closeActive = () => {
    if (!activeEntry) return;
    const prev = activeEntry;
    activeEntry = null;
    prev.close();
  };

  const isDisconnected = (el: Element | null): boolean =>
    Boolean(el && "isConnected" in el && el.isConnected === false);

  const session: TooltipSession = {
    isWarm: () => warm,
    activeKey: () => activeEntry?.key ?? null,
    suppressedElement: () => suppressedEl,

    enter(entry, delayMs) {
      if (suppressedEl && entry.trigger && !containsNode(suppressedEl, entry.trigger)) {
        suppressedEl = null;
      }
      if (suppressedEl && entry.trigger && containsNode(suppressedEl, entry.trigger)) {
        return;
      }
      if (isDisconnected(entry.trigger)) {
        return;
      }
      if (entry.trigger && isTooltipSuppressedTarget(entry.trigger)) {
        if (activeEntry && activeEntry.key !== entry.key) {
          closeActive();
          if (warm) startCooldown();
        }
        return;
      }

      if (warm) {
        clearShowTimer();
        clearCooldownTimer();
        if (activeEntry && activeEntry.key === entry.key) return;
        closeActive();
        activeEntry = entry;
        entry.open(true);
        return;
      }

      if (pendingEntry && pendingEntry.key === entry.key) return;
      clearShowTimer();
      clearCooldownTimer();
      pendingEntry = entry;
      showTimer = timers.setTimeout(() => {
        showTimer = undefined;
        if (pendingEntry?.key !== entry.key) return;
        pendingEntry = null;
        if (suppressedEl && entry.trigger && containsNode(suppressedEl, entry.trigger)) return;
        if (isDisconnected(entry.trigger)) return;
        if (entry.trigger && isTooltipSuppressedTarget(entry.trigger)) return;
        closeActive();
        warm = true;
        activeEntry = entry;
        entry.open(false);
      }, delayMs ?? coldDelayMs);
    },

    focus(entry) {
      if (suppressedEl && entry.trigger && containsNode(suppressedEl, entry.trigger)) {
        return;
      }
      if (isDisconnected(entry.trigger)) return;
      if (entry.trigger && isTooltipSuppressedTarget(entry.trigger)) return;

      clearShowTimer();
      clearCooldownTimer();
      if (activeEntry && activeEntry.key === entry.key) return;
      const useInstant = warm;
      closeActive();
      warm = true;
      activeEntry = entry;
      entry.open(useInstant);
    },

    leave(key) {
      if (pendingEntry && pendingEntry.key === key) {
        clearShowTimer();
      }
      if (activeEntry && activeEntry.key === key) {
        closeActive();
        if (warm) startCooldown();
      }
    },

    dismissKey(key) {
      if (pendingEntry && pendingEntry.key === key) {
        clearShowTimer();
      }
      if (activeEntry && activeEntry.key === key) {
        const trigger = activeEntry.trigger;
        closeActive();
        if (trigger && trigger.getAttribute("aria-expanded") === "true") {
          clearCooldownTimer();
          warm = false;
          suppressedEl = trigger;
        } else if (warm) {
          startCooldown();
        }
      }
    },

    dismissTransient() {
      clearShowTimer();
      clearCooldownTimer();
      warm = false;
      closeActive();
    },

    hardReset(trigger) {
      clearShowTimer();
      clearCooldownTimer();
      warm = false;
      closeActive();
      suppressedEl = trigger ?? null;
    },

    notifyPointerOut(target, relatedTarget) {
      if (!suppressedEl) return;
      if (isDisconnected(suppressedEl)) {
        suppressedEl = null;
        return;
      }
      if (isNodeLike(relatedTarget)) {
        if (!containsNode(suppressedEl, relatedTarget)) {
          suppressedEl = null;
        }
        return;
      }
      if (target === suppressedEl) {
        suppressedEl = null;
      }
    },

    notifyPointerOver(target) {
      if (!suppressedEl) return;
      if (isDisconnected(suppressedEl)) {
        suppressedEl = null;
        return;
      }
      if (isNodeLike(target) && !containsNode(suppressedEl, target)) {
        suppressedEl = null;
      }
    },

    retainGlobalListeners() {
      listenerRefs++;
      if (listenerRefs === 1 && typeof document !== "undefined") {
        const doc = document;
        const win = typeof window !== "undefined" ? window : undefined;

        const onPointerDown = (e: PointerEvent) => {
          const base = isElementLike(e.target) ? e.target : null;
          const trigger = base?.closest?.(ANY_TRIGGER_SELECTOR) ?? null;
          session.hardReset(trigger);
        };
        const onPointerOut = (e: PointerEvent) => {
          session.notifyPointerOut(e.target, e.relatedTarget);
        };
        const onPointerOver = (e: PointerEvent) => {
          session.notifyPointerOver(e.target);
        };
        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
            const base = isElementLike(e.target)
              ? e.target
              : isElementLike(doc.activeElement)
                ? doc.activeElement
                : null;
            const trigger = base?.closest?.(ANY_TRIGGER_SELECTOR) ?? null;
            session.hardReset(trigger);
          }
        };
        const onTransient = () => {
          session.dismissTransient();
        };

        doc.addEventListener("pointerdown", onPointerDown, true);
        doc.addEventListener("pointerout", onPointerOut, true);
        doc.addEventListener("pointerover", onPointerOver, true);
        doc.addEventListener("keydown", onKeyDown, true);
        doc.addEventListener("scroll", onTransient, { capture: true, passive: true });
        doc.addEventListener("visibilitychange", onTransient);
        win?.addEventListener("wheel", onTransient, { passive: true });
        win?.addEventListener("blur", onTransient);

        detachGlobal = () => {
          doc.removeEventListener("pointerdown", onPointerDown, true);
          doc.removeEventListener("pointerout", onPointerOut, true);
          doc.removeEventListener("pointerover", onPointerOver, true);
          doc.removeEventListener("keydown", onKeyDown, true);
          doc.removeEventListener("scroll", onTransient, true);
          doc.removeEventListener("visibilitychange", onTransient);
          win?.removeEventListener("wheel", onTransient);
          win?.removeEventListener("blur", onTransient);
        };
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        listenerRefs = Math.max(0, listenerRefs - 1);
        if (listenerRefs === 0 && detachGlobal) {
          const cleanup = detachGlobal;
          detachGlobal = null;
          cleanup();
        }
      };
    },

    setTimers(nextTimers) {
      session.hardReset(null);
      timers = nextTimers ?? defaultTimers;
    },
  };

  return session;
}

export const tooltipSession = createTooltipSession();
