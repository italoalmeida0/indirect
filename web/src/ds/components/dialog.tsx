import { createEffect, createSignal, createUniqueId, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import { animate } from "../motion/animate";
import { createPresence } from "../motion/presence";
import { motionTokens, tween } from "../motion/tokens";
import { hasLegacyFloating, isTopLayer, lockScroll, pushLayer, trapFocus, type Layer } from "../primitives/layers";
import { Glyph } from "./icon";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  onEscape?: () => boolean | void;
  title: string;
  description?: string;
  /** Legacy alias of `description`. */
  subtitle?: string;
  badge?: JSX.Element;
  /** Tailwind max-width class for the panel (default max-w-xl). */
  width?: string;
  /** Phones: inset card that never runs under the status bar (default true). */
  fullOnMobile?: boolean;
  /** Render children directly as the dialog surface without default header/body/footer chrome. */
  chromeless?: boolean;
  footer?: JSX.Element;
  children: JSX.Element;
  bodyRef?: (el: HTMLDivElement | undefined) => void;
}

/**
 * A focused surface for decisions that need attention (Arc "Dialog").
 *
 * Motion: the scrim fades; the panel rises 8px from 96% on spring.smooth
 * while its opacity tweens; the exit is faster (to 98%, 4px down). The
 * panel stays mounted until the exit finishes, and a reopen mid-exit
 * reverses from wherever it is. While open the app root is inert, page
 * scroll is locked, Tab is trapped and focus returns to the trigger.
 */
export function Dialog(props: DialogProps) {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const description = () => props.subtitle ?? props.description;
  let scrim: HTMLDivElement | undefined;
  let anchorEl: HTMLSpanElement | undefined;
  const readDensity = () =>
    anchorEl?.closest?.("[data-density]")?.getAttribute("data-density") ??
    (typeof document !== "undefined" ? document.querySelector(".rc-app-shell[data-density]")?.getAttribute("data-density") : null) ??
    undefined;
  const [inheritedDensity, setInheritedDensity] = createSignal<string | undefined>(undefined);

  const presence = createPresence(() => props.open, {
    enter: (panel) => {
      if (scrim) animate(scrim, { opacity: "1" }, { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter }, { from: { opacity: "0" } });
      animate(panel, { opacity: "1" }, { duration: motionTokens.duration.fast, ease: motionTokens.ease.enter }, { from: { opacity: "0" } });
      return animate(panel, { transform: "none" }, motionTokens.spring.smooth, { from: { transform: "translateY(8px) scale(0.96)" } });
    },
    exit: (panel) => {
      if (scrim) animate(scrim, { opacity: "0" }, tween.exit);
      return animate(panel, { opacity: "0", transform: "translateY(4px) scale(0.98)" }, tween.exit);
    },
  });

  const [panelEl, setPanelEl] = createSignal<HTMLDivElement>();

  createEffect(() => {
    if (presence.present()) setInheritedDensity(readDensity());
  });

  createEffect(() => {
    const panel = panelEl();
    if (!props.open || !panel) return;
    const layer: Layer = {
      kind: "modal",
      contains: (node) => panel.contains(node),
      onEscape: () => {
        // Unmigrated floating menus or inline confirm morphs own Escape first.
        if (hasLegacyFloating()) return false;
        if (panel.querySelector('[data-confirm-phase="confirm"]')) return false;
        if (!props.open) return false;
        if (props.onEscape) return props.onEscape();
        props.onClose();
      },
    };
    const removeLayer = pushLayer(layer);
    const unlock = lockScroll();
    const release = trapFocus(panel, () => isTopLayer(layer) && props.open);
    onCleanup(() => {
      removeLayer();
      unlock();
      release();
    });
  });

  const setup = (panel: HTMLDivElement) => {
    setPanelEl(panel);
    presence.ref(panel);
    onCleanup(() => setPanelEl(undefined));
  };

  return (
    <>
      <span ref={(el) => { anchorEl = el; }} class="hidden" aria-hidden="true" />
      <Show when={presence.present()}>
        <Portal>
          <div
            class="ui-dialog-backdrop"
            data-density={inheritedDensity() ?? readDensity()}
            data-state={presence.state()}
            style={{ "z-index": "var(--z-modal)" }}
            onMouseDown={(event) => {
              if (!props.open) return;
              if (event.target === event.currentTarget || event.target === scrim) props.onClose();
            }}
          >
          <div ref={scrim} class="ui-dialog-scrim" aria-hidden="true" />
          <div
            ref={setup}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description() ? descriptionId : undefined}
            tabindex="-1"
            data-state={presence.state()}
            class={`ui-dialog flex my-auto min-h-0 w-full flex-col overflow-hidden outline-none ${props.width ?? "max-w-xl"} ${
              props.fullOnMobile !== false ? "ui-dialog-full sm:max-h-[90dvh]" : "max-h-[calc(100dvh-2rem)] sm:max-h-[90dvh]"
            }`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <Show
              when={!props.chromeless}
              fallback={
                <>
                  <h3 id={titleId} class="sr-only">{props.title}</h3>
                  {props.children}
                </>
              }
            >
              <div class="ui-dialog-header">
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 id={titleId} class="ui-dialog-title">{props.title}</h3>
                    {props.badge}
                  </div>
                  <Show when={description()}>
                    <p id={descriptionId} class="ui-dialog-description">{description()}</p>
                  </Show>
                </div>
                <button type="button" class="ui-dialog-close" aria-label="Close" data-tip="Close" onClick={() => props.onClose()}>
                  <Glyph icon="lucide:x" size={16} />
                </button>
              </div>
              <div ref={(el) => props.bodyRef?.(el)} class="ui-dialog-body min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
                {props.children}
              </div>
              <Show when={props.footer}>
                <div class="ui-dialog-footer">{props.footer}</div>
              </Show>
            </Show>
          </div>
        </div>
        </Portal>
      </Show>
    </>
  );
}
