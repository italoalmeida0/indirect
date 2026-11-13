import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

import { animate, type Controls } from "../motion/animate";
import { collapseHeight, expandHeight } from "../motion/morph";
import { createPresence } from "../motion/presence";
import { press } from "../motion/press";
import { motionTokens, tween } from "../motion/tokens";
import { isTopLayer, lockScroll, pushLayer, trapFocus, type Layer } from "../primitives/layers";

/* ---------------------------------------------------------------- Drawer */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. */
  label: string;
  side?: "left" | "right" | "bottom";
  class?: string;
  children: JSX.Element;
}

const OFFSCREEN = { left: "translateX(-100%)", right: "translateX(100%)", bottom: "translateY(100%)" } as const;

/**
 * A temporary side (or bottom) surface for focused work (Arc "Drawer" /
 * "Bottom sheet"). Slides in on spring.smooth, follows the finger when
 * dragged toward its edge, and closes past a third of its size or on a
 * flick. Traps focus, locks scroll, makes the app inert, closes on Escape.
 */
export function Drawer(props: DrawerProps) {
  const side = () => props.side ?? "left";
  let scrim: HTMLDivElement | undefined;
  const presence = createPresence(() => props.open, {
    enter: (panel) => {
      if (scrim) animate(scrim, { opacity: "1" }, tween.enter, { from: { opacity: "0" } });
      return animate(panel, { transform: "none" }, motionTokens.spring.smooth, { from: { transform: OFFSCREEN[side()] } });
    },
    exit: (panel) => {
      if (scrim) animate(scrim, { opacity: "0" }, tween.exit);
      return animate(panel, { transform: OFFSCREEN[side()] }, { duration: 0.22, ease: motionTokens.ease.inOut });
    },
  });

  const [panelEl, setPanelEl] = createSignal<HTMLDivElement>();

  createEffect(() => {
    const panel = panelEl();
    if (!props.open || !panel) return;
    const layer: Layer = { kind: "drawer", contains: (node) => panel.contains(node), onEscape: () => props.onClose() };
    const removeLayer = pushLayer(layer);
    const unlock = lockScroll();
    const release = trapFocus(panel, () => isTopLayer(layer) && props.open);
    onCleanup(() => { removeLayer(); unlock(); release(); });
  });

  const setup = (panel: HTMLDivElement) => {
    setPanelEl(panel);
    presence.ref(panel);
    onCleanup(() => setPanelEl(undefined));

    // Drag toward the edge to dismiss (touch and pen; mouse uses the scrim).
    let start = 0;
    let startTime = 0;
    let pointer: number | undefined;
    const axis = () => (side() === "bottom" ? "y" : "x");
    const sign = () => (side() === "left" ? -1 : 1);
    const delta = (event: PointerEvent) => (axis() === "x" ? event.clientX : event.clientY) - start;
    panel.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || (event.target as HTMLElement).closest("input, textarea, [contenteditable], button, a, [data-no-drag]")) return;
      pointer = event.pointerId;
      start = axis() === "x" ? event.clientX : event.clientY;
      startTime = performance.now();
    });
    panel.addEventListener("pointermove", (event) => {
      if (pointer !== event.pointerId) return;
      const moved = Math.max(0, delta(event) * sign());
      if (moved > 4) panel.setPointerCapture(event.pointerId);
      panel.style.transform = axis() === "x" ? `translateX(${moved * sign()}px)` : `translateY(${moved}px)`;
    });
    const end = (event: PointerEvent) => {
      if (pointer !== event.pointerId) return;
      pointer = undefined;
      const moved = Math.max(0, delta(event) * sign());
      const size = axis() === "x" ? panel.offsetWidth : panel.offsetHeight;
      const velocity = moved / Math.max(1, performance.now() - startTime);
      if (moved > size / 3 || velocity > 0.6) props.onClose();
      else animate(panel, { transform: "none" }, motionTokens.spring.snappy);
    };
    panel.addEventListener("pointerup", end);
    panel.addEventListener("pointercancel", end);
  };

  const position = () => side() === "bottom"
    ? "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-[var(--radius-surface)] pb-[var(--sab)]"
    : `inset-y-0 ${side() === "left" ? "left-0 rounded-r-[var(--radius-panel)]" : "right-0 rounded-l-[var(--radius-panel)]"} w-[min(85vw,22rem)]`;

  return (
    <Show when={presence.present()}>
      <Portal>
        <div class={`fixed inset-0 ${props.open ? "" : "pointer-events-none"}`} style={{ "z-index": "var(--z-drawer)" }} data-state={presence.state()}>
          <div ref={scrim} class="ui-dialog-scrim" aria-hidden="true" onClick={() => { if (props.open) props.onClose(); }} />
          <div
            ref={setup}
            role="dialog"
            aria-modal="true"
            aria-label={props.label}
            tabIndex={-1}
            class={`fixed flex flex-col overflow-hidden border border-border bg-surface-raised shadow-floating outline-none touch-pan-y ${position()} ${props.class ?? ""}`}
          >
            <Show when={side() === "bottom"}>
              <div class="mx-auto mt-2 mb-1 h-1 w-9 shrink-0 rounded-pill bg-border-strong" aria-hidden="true" />
            </Show>
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/* -------------------------------------------------------------- Collapse */

/**
 * Progressively reveal content in place (Arc "Accordion" body). Height and
 * opacity move together on spring.smooth (no overshoot); closing is faster.
 * Content stays unmounted while closed.
 */
export function Collapse(props: { open: boolean; children: JSX.Element; class?: string }) {
  const presence = createPresence(() => props.open, {
    enter: (el): Controls => expandHeight(el),
    exit: (el): Controls => collapseHeight(el),
  });
  return (
    <Show when={presence.present()}>
      <div ref={presence.ref} class={props.class}>{props.children}</div>
    </Show>
  );
}

/* --------------------------------------------------------- ConfirmButton */

export interface ConfirmButtonProps {
  /** Resting label, e.g. "Revoke key". */
  label: string;
  /** Inline question, e.g. "Revoke this key?". */
  question?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<unknown> | unknown;
  size?: "xs" | "sm";
  disabled?: boolean;
  class?: string;
}

/**
 * A destructive button that morphs into an inline confirmation, then a
 * spinner, then a result (Arc "Confirm morph"). No dialog for a single
 * destructive step; the decision happens where the pointer already is.
 * Escape or focus leaving cancels.
 */
export function ConfirmButton(props: ConfirmButtonProps) {
  const [phase, setPhase] = createSignal<"idle" | "confirm" | "busy" | "done" | "error">("idle");
  let root: HTMLSpanElement | undefined;
  const morph = () => {
    if (!root) return;
    const from = root.getBoundingClientRect().width;
    queueMicrotask(() => {
      if (!root) return;
      const to = root.scrollWidth;
      animate(root, { width: `${to}px` }, motionTokens.spring.morph, { from: { width: `${from}px` }, clear: ["width"] });
    });
  };
  const go = (next: ReturnType<typeof phase>) => {
    morph();
    setPhase(next);
  };
  const confirm = async () => {
    go("busy");
    try {
      await props.onConfirm();
      go("done");
      window.setTimeout(() => go("idle"), 1400);
    } catch {
      go("error");
      window.setTimeout(() => go("idle"), 2000);
    }
  };
  const size = () => props.size ?? "xs";
  return (
    <span
      ref={root}
      data-confirm-phase={phase()}
      class={`inline-flex items-center gap-1.5 overflow-hidden whitespace-nowrap ${props.class ?? ""}`}
      onKeyDown={(event) => { if (event.key === "Escape" && phase() === "confirm") { event.stopPropagation(); go("idle"); } }}
      onFocusOut={(event) => { if (phase() === "confirm" && !root?.contains(event.relatedTarget as Node)) go("idle"); }}
    >
      <Show when={phase() === "idle"}>
        <button type="button" ref={press} disabled={props.disabled} class={`ui-button ui-button-danger ui-button-${size()}`} onClick={() => go("confirm")}>
          <span class="ui-button-label">{props.label}</span>
        </button>
      </Show>
      <Show when={phase() === "confirm"}>
        <span class="text-sm text-fg-secondary px-1">{props.question ?? "Are you sure?"}</span>
        <button type="button" ref={press} class={`ui-button ui-button-ghost ui-button-${size()}`} onClick={() => go("idle")}>
          <span class="ui-button-label">Cancel</span>
        </button>
        <button type="button" ref={(el) => { press(el); queueMicrotask(() => el.focus({ preventScroll: true })); }} class={`ui-button ui-button-danger-solid ui-button-${size()}`} onClick={() => void confirm()}>
          <span class="ui-button-label">{props.confirmLabel ?? props.label}</span>
        </button>
      </Show>
      <Show when={phase() === "busy"}>
        <span class={`ui-button ui-button-secondary ui-button-${size()}`} aria-busy="true" role="status" aria-label="Working">
          <span class="ui-spinner" />
        </span>
      </Show>
      <Show when={phase() === "done" || phase() === "error"}>
        <span class={`text-sm px-2 ${phase() === "done" ? "text-success" : "text-danger"}`} role="status">
          {phase() === "done" ? "Done" : "Failed. Try again"}
        </span>
      </Show>
    </span>
  );
}
