import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat } from "../../floating";
import {
  isElementLike,
  isFocusVisibleTarget,
  isMobileTooltipEnvironment,
  isNodeLike,
  isTooltipSuppressedTarget,
  TOOLTIP_ANCHOR_ATTR,
  TOOLTIP_COLD_DELAY_MS,
  tooltipSession,
  type TooltipEntry,
  type TooltipSession,
} from "../tooltip-session";

export interface TooltipProps {
  content: JSX.Element;
  placement?: Placement;
  /** Hover-intent delay in ms when cold (default 500; 0 while tooltip session is warm). */
  delay?: number;
  disabled?: boolean;
  children: JSX.Element;
}

export interface BindTooltipTriggerOptions {
  anchor: HTMLElement;
  isDisabled: () => boolean;
  hasContent: () => boolean;
  getDelay: () => number;
  onOpen: (instant: boolean) => void;
  onClose: () => void;
  session?: TooltipSession;
}

export function bindTooltipTrigger(opts: BindTooltipTriggerOptions): {
  cleanup: () => void;
  dismiss: () => void;
} {
  const session = opts.session ?? tooltipSession;
  const sessionKey = Symbol("ds-tooltip");

  const entry: TooltipEntry = {
    key: sessionKey,
    trigger: opts.anchor,
    open: (useInstant) => {
      if (opts.isDisabled() || !opts.hasContent()) return;
      if ("isConnected" in opts.anchor && opts.anchor.isConnected === false) return;
      if (isTooltipSuppressedTarget(opts.anchor)) return;
      opts.onOpen(useInstant);
    },
    close: () => {
      opts.onClose();
    },
  };

  const onPointerEnter = (e: PointerEvent) => {
    if (opts.isDisabled() || !opts.hasContent()) return;
    if (e.pointerType === "touch" || isMobileTooltipEnvironment()) return;
    if ((e.buttons ?? 0) !== 0) return;
    if (isTooltipSuppressedTarget(opts.anchor)) return;
    session.enter(entry, opts.getDelay());
  };

  const onPointerLeave = () => {
    session.leave(sessionKey);
  };

  const onPointerDown = () => {
    session.hardReset(opts.anchor);
  };

  const onFocusIn = (e: FocusEvent) => {
    if (opts.isDisabled() || !opts.hasContent()) return;
    if (isTooltipSuppressedTarget(opts.anchor)) return;
    const target = isElementLike(e.target) ? e.target : null;
    if (isFocusVisibleTarget(target) || isFocusVisibleTarget(opts.anchor)) {
      session.focus(entry);
    }
  };

  const onFocusOut = (e: FocusEvent) => {
    if (isNodeLike(e.relatedTarget) && opts.anchor.contains(e.relatedTarget)) return;
    session.leave(sessionKey);
  };

  opts.anchor.addEventListener("pointerenter", onPointerEnter);
  opts.anchor.addEventListener("pointerleave", onPointerLeave);
  opts.anchor.addEventListener("pointerdown", onPointerDown);
  opts.anchor.addEventListener("focusin", onFocusIn);
  opts.anchor.addEventListener("focusout", onFocusOut);
  const releaseGlobal = session.retainGlobalListeners();

  return {
    dismiss: () => session.dismissKey(sessionKey),
    cleanup: () => {
      opts.anchor.removeEventListener("pointerenter", onPointerEnter);
      opts.anchor.removeEventListener("pointerleave", onPointerLeave);
      opts.anchor.removeEventListener("pointerdown", onPointerDown);
      opts.anchor.removeEventListener("focusin", onFocusIn);
      opts.anchor.removeEventListener("focusout", onFocusOut);
      releaseGlobal();
      session.dismissKey(sessionKey);
    },
  };
}

/**
 * Short supporting text for unfamiliar controls (Arc "Tooltip").
 *
 * Shares the document-wide warm-roving session (`tooltip-session.ts`) with
 * delegated `[data-rc-tip]` / `[data-tip]` tooltips: the first cold hover waits
 * 500ms and rises gently; roving between triggers while warm switches at 0ms
 * with `data-instant`, and `pointerdown` or `aria-expanded="true"` suppresses it.
 */
export function Tooltip(props: TooltipProps) {
  const [show, setShow] = createSignal(false);
  const [instant, setInstant] = createSignal(false);
  const id = createUniqueId();
  let anchor: HTMLSpanElement | undefined;
  let dismissSelf: (() => void) | undefined;

  const hasContent = () => {
    const c = props.content;
    if (c === null || c === undefined || typeof c === "boolean") return false;
    if (typeof c === "string") return c.trim().length > 0;
    return true;
  };

  onMount(() => {
    if (!anchor) return;
    const binding = bindTooltipTrigger({
      anchor,
      isDisabled: () => Boolean(props.disabled),
      hasContent,
      getDelay: () => props.delay ?? TOOLTIP_COLD_DELAY_MS,
      onOpen: (useInstant) => {
        setInstant(useInstant);
        setShow(true);
      },
      onClose: () => {
        setShow(false);
      },
    });
    dismissSelf = binding.dismiss;
    onCleanup(binding.cleanup);
  });

  createEffect(() => {
    if (!show()) return;
    if (props.disabled || !hasContent() || !anchor || isTooltipSuppressedTarget(anchor)) {
      dismissSelf?.();
      return;
    }
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (!anchor?.isConnected || isTooltipSuppressedTarget(anchor)) {
        dismissSelf?.();
      }
    });
    observer.observe(anchor, {
      attributes: true,
      subtree: true,
      attributeFilter: ["aria-expanded", "data-tip-busy"],
    });
    onCleanup(() => observer.disconnect());
  });

  return (
    <>
      <span
        ref={anchor}
        class="inline-flex max-w-full"
        {...{ [TOOLTIP_ANCHOR_ATTR]: !props.disabled && hasContent() ? "" : undefined }}
      >
        {props.children}
      </span>
      <Show when={show()}>
        <Portal>
          <div
            id={id}
            ref={(el) => {
              onCleanup(anchorFloat(anchor!, el, { placement: props.placement ?? "top", gap: 8 }));
            }}
            role="tooltip"
            data-instant={instant() ? "" : undefined}
            class="ui-tooltip w-max"
          >
            {props.content}
          </div>
        </Portal>
      </Show>
    </>
  );
}
