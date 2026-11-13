import { batch, createEffect, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";
import { anchorFloat } from "../floating";
import { Icon } from "../components/icon";
import {
  DELEGATED_TIP_SELECTOR,
  getDelegatedTooltipText,
  isElementLike,
  isFocusVisibleTarget,
  isMobileTooltipEnvironment,
  isTooltipSuppressedTarget,
  resolveTooltipPlacement,
  tooltipSession,
  type TooltipEntry,
  type TooltipSession,
} from "../ds/tooltip-session";

import { fileIcon } from "./files";
export { fileIcon } from "./files";

export function FileIcon(props: { path: string; size?: number }) {
  return <Icon icon={fileIcon(props.path).icon} class={fileIcon(props.path).class} size={props.size ?? 15} />;
}

export interface DelegatedTooltipState {
  target: HTMLElement;
  text: string;
  placement: Placement;
  instant: boolean;
}

export interface BindDelegatedTooltipsOptions {
  doc?: Document;
  session?: TooltipSession;
  onUpdate: (state: DelegatedTooltipState | null) => void;
}

const INTERACTIVE_PARENT_SELECTOR = 'button, a, summary, [role="button"], [role="combobox"]';
const OBSERVED_ATTRS = [
  "data-rc-tip",
  "data-tip",
  "data-rc-tip-placement",
  "data-tip-placement",
  "aria-expanded",
  "data-tip-busy",
  "disabled",
];

export function bindDelegatedTooltips(opts: BindDelegatedTooltipsOptions): () => void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  const session = opts.session ?? tooltipSession;
  if (!doc) return () => {};

  let activeEl: HTMLElement | null = null;
  let armedEl: HTMLElement | null = null;
  let currentInstant = false;
  let attrObserver: MutationObserver | null = null;
  let treeObserver: MutationObserver | null = null;

  const stopObservers = () => {
    attrObserver?.disconnect();
    attrObserver = null;
    treeObserver?.disconnect();
    treeObserver = null;
  };

  const syncActiveTarget = () => {
    if (!activeEl) return;
    if (
      ("isConnected" in activeEl && activeEl.isConnected === false) ||
      isTooltipSuppressedTarget(activeEl)
    ) {
      session.dismissKey(activeEl);
      return;
    }
    const nextText = getDelegatedTooltipText(activeEl);
    if (!nextText) {
      session.dismissKey(activeEl);
      return;
    }
    opts.onUpdate({
      target: activeEl,
      text: nextText,
      placement: resolveTooltipPlacement(activeEl),
      instant: currentInstant,
    });
  };

  const entryFor = (el: HTMLElement): TooltipEntry => ({
    key: el,
    trigger: el,
    open: (useInstant) => {
      if (("isConnected" in el && el.isConnected === false) || isTooltipSuppressedTarget(el)) {
        return;
      }
      const tipText = getDelegatedTooltipText(el);
      if (!tipText) return;
      stopObservers();
      activeEl = el;
      armedEl = el;
      currentInstant = useInstant;
      opts.onUpdate({
        target: el,
        text: tipText,
        placement: resolveTooltipPlacement(el),
        instant: useInstant,
      });

      if (typeof MutationObserver !== "undefined") {
        attrObserver = new MutationObserver(syncActiveTarget);
        attrObserver.observe(el, { attributes: true, attributeFilter: OBSERVED_ATTRS });
        const interactiveParent =
          typeof el.closest === "function" ? el.closest(INTERACTIVE_PARENT_SELECTOR) : null;
        if (interactiveParent && interactiveParent !== el) {
          attrObserver.observe(interactiveParent, {
            attributes: true,
            attributeFilter: ["aria-expanded", "data-tip-busy", "disabled"],
          });
        }
        if (doc.body) {
          treeObserver = new MutationObserver(() => {
            if (activeEl && "isConnected" in activeEl && activeEl.isConnected === false) {
              session.dismissKey(activeEl);
            }
          });
          treeObserver.observe(doc.body, { childList: true, subtree: true });
        }
      }
    },
    close: () => {
      if (armedEl === el) armedEl = null;
      if (activeEl !== el) return;
      stopObservers();
      activeEl = null;
      opts.onUpdate(null);
    },
  });

  const over = (e: PointerEvent) => {
    // Same source of truth as the CSS: the pre-paint html.mobile flag
    // (`document.documentElement.classList.contains("mobile")`).
    if (e.pointerType === "touch" || isMobileTooltipEnvironment()) return;
    const base = isElementLike(e.target) ? e.target : null;
    const el = base?.closest<HTMLElement>(DELEGATED_TIP_SELECTOR) ?? null;
    if (armedEl && armedEl !== el) {
      const stale = armedEl;
      armedEl = null;
      session.leave(stale);
    }
    if ((e.buttons ?? 0) !== 0) return;
    if (!el) return;
    const prevTipEl = isElementLike(e.relatedTarget)
      ? e.relatedTarget.closest<HTMLElement>(DELEGATED_TIP_SELECTOR)
      : null;
    if (prevTipEl === el) return;
    if (isTooltipSuppressedTarget(el)) return;
    armedEl = el;
    session.enter(entryFor(el));
  };

  const out = (e: PointerEvent) => {
    const base = isElementLike(e.target) ? e.target : null;
    const el = base?.closest<HTMLElement>(DELEGATED_TIP_SELECTOR) ?? null;
    if (!el) return;
    const nextTipEl = isElementLike(e.relatedTarget)
      ? e.relatedTarget.closest<HTMLElement>(DELEGATED_TIP_SELECTOR)
      : null;
    if (nextTipEl !== el) {
      if (armedEl === el) armedEl = null;
      session.leave(el);
    }
  };

  const focusIn = (e: FocusEvent) => {
    const base = isElementLike(e.target) ? e.target : null;
    const el = base?.closest<HTMLElement>(DELEGATED_TIP_SELECTOR) ?? null;
    if (!el || isTooltipSuppressedTarget(el)) return;
    if (isFocusVisibleTarget(base) || isFocusVisibleTarget(el)) {
      armedEl = el;
      session.focus(entryFor(el));
    }
  };

  const focusOut = (e: FocusEvent) => {
    const base = isElementLike(e.target) ? e.target : null;
    const el = base?.closest<HTMLElement>(DELEGATED_TIP_SELECTOR) ?? null;
    if (!el) return;
    const nextTipEl = isElementLike(e.relatedTarget)
      ? e.relatedTarget.closest<HTMLElement>(DELEGATED_TIP_SELECTOR)
      : null;
    if (nextTipEl !== el) {
      if (armedEl === el) armedEl = null;
      session.leave(el);
    }
  };

  doc.addEventListener("pointerover", over);
  doc.addEventListener("pointerout", out);
  doc.addEventListener("focusin", focusIn);
  doc.addEventListener("focusout", focusOut);
  const releaseGlobal = session.retainGlobalListeners();

  return () => {
    stopObservers();
    doc.removeEventListener("pointerover", over);
    doc.removeEventListener("pointerout", out);
    doc.removeEventListener("focusin", focusIn);
    doc.removeEventListener("focusout", focusOut);
    releaseGlobal();
    const pendingOrActive = activeEl ?? armedEl;
    activeEl = null;
    armedEl = null;
    if (pendingOrActive) session.dismissKey(pendingOrActive);
    opts.onUpdate(null);
  };
}

interface RemoteHintsOwnerSlot {
  active: boolean;
  setActive: (next: boolean) => void;
}

const remoteHintsSlots: RemoteHintsOwnerSlot[] = [];

export function claimRemoteHintsOwner(setActive: (next: boolean) => void): () => void {
  const hasActive = remoteHintsSlots.some((slot) => slot.active);
  const slot: RemoteHintsOwnerSlot = { active: !hasActive, setActive };
  remoteHintsSlots.push(slot);
  if (slot.active) {
    setActive(true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = remoteHintsSlots.indexOf(slot);
    if (idx !== -1) remoteHintsSlots.splice(idx, 1);
    const wasActive = slot.active;
    slot.active = false;
    setActive(false);
    if (wasActive && remoteHintsSlots.length > 0) {
      const next = remoteHintsSlots[0]!;
      next.active = true;
      next.setActive(true);
    }
  };
}

export function getActiveRemoteHintsCount(): number {
  let count = 0;
  for (const slot of remoteHintsSlots) {
    if (slot.active) count++;
  }
  return count;
}

/** Delegated hints preserve row layout and work across every route and portaled dialog. */
export function RemoteHints() {
  const [isOwner, setIsOwner] = createSignal(false);
  const [target, setTarget] = createSignal<HTMLElement | null>(null);
  const [text, setText] = createSignal("");
  const [placement, setPlacement] = createSignal<Placement>("top");
  const [instant, setInstant] = createSignal(false);
  const id = createUniqueId();
  let described: HTMLElement | null = null;

  const clearDescribed = () => {
    if (described?.getAttribute("aria-describedby") === id) {
      described.removeAttribute("aria-describedby");
    }
    described = null;
  };

  onMount(() => {
    const releaseOwner = claimRemoteHintsOwner(setIsOwner);
    onCleanup(() => {
      releaseOwner();
      clearDescribed();
    });
  });

  createEffect(() => {
    if (!isOwner()) {
      clearDescribed();
      setTarget(null);
      return;
    }
    const unbind = bindDelegatedTooltips({
      onUpdate: (state) => {
        batch(() => {
          if (!state) {
            clearDescribed();
            setTarget(null);
            return;
          }
          if (described !== state.target) {
            clearDescribed();
            if (!state.target.hasAttribute("aria-describedby")) {
              state.target.setAttribute("aria-describedby", id);
              described = state.target;
            }
          }
          setInstant(state.instant);
          setText(state.text);
          setPlacement(state.placement);
          setTarget(state.target);
        });
      },
    });
    onCleanup(() => {
      unbind();
      clearDescribed();
    });
  });

  return (
    <Show when={isOwner() ? target() : null} keyed>
      {(el) => (
        <Portal>
          <div
            id={id}
            role="tooltip"
            data-density={el.closest?.("[data-density]")?.getAttribute("data-density") ?? undefined}
            data-instant={instant() ? "" : undefined}
            ref={(node) => onCleanup(anchorFloat(el, node, { placement: placement(), gap: 8 }))}
            class="ui-tooltip pointer-events-none w-max max-w-[min(18rem,calc(100vw-1rem))] whitespace-pre-wrap break-words"
          >
            {text()}
          </div>
        </Portal>
      )}
    </Show>
  );
}
