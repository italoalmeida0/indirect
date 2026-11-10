/**
 * Overlay primitives shared by every floating surface (dialog, drawer,
 * sheet, popover, menu, select, tooltip).
 *
 * One LAYER STACK decides who owns Escape and outside clicks: the topmost
 * layer gets them first, so a menu inside a dialog closes before the dialog,
 * and the dialog never needs to sniff the DOM for open menus.
 *
 * Unmigrated surfaces that still mark themselves with [data-floatmenu] or
 * role=listbox are respected by `hasLegacyFloating()`.
 */

export type LayerKind = "modal" | "drawer" | "popover" | "menu" | "tooltip";

export interface Layer {
  kind: LayerKind;
  /** Elements that belong to the layer (panel + trigger): clicks inside are not "outside". */
  contains: (node: Node) => boolean;
  onEscape?: () => void;
  onOutside?: (event: PointerEvent) => void;
}

const stack: Layer[] = [];
let listening = false;

function onKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]!;
    if (layer.kind === "tooltip" && !layer.onEscape) continue;
    if (layer.onEscape) {
      event.preventDefault();
      event.stopPropagation();
      layer.onEscape();
    }
    return;
  }
}

function onPointerDown(event: PointerEvent) {
  const target = event.target;
  if (!(target instanceof Node)) return;
  // Walk from the top: close every non-modal layer the click is outside of,
  // stop at the first layer that contains it or at a modal boundary.
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]!;
    if (layer.contains(target)) return;
    if (layer.kind === "tooltip") continue;
    layer.onOutside?.(event);
    if (layer.kind === "modal" || layer.kind === "drawer") return;
  }
}

function ensureListening() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
}

/** Register a layer; returns its removal. */
export function pushLayer(layer: Layer): () => void {
  ensureListening();
  stack.push(layer);
  syncInert();
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
    syncInert();
  };
}

/** True when `layer` is the topmost non-tooltip layer. */
export function isTopLayer(layer: Layer): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.kind === "tooltip") continue;
    return stack[i] === layer;
  }
  return false;
}

/** Legacy floating surfaces that are not on the stack yet. */
export function hasLegacyFloating(): boolean {
  return typeof document !== "undefined" && !!document.querySelector("[data-floatmenu], [role=listbox]");
}

// ---- Background inertness -------------------------------------------------

/** While a modal or drawer is open the app root is inert: no focus, no
 *  clicks, hidden from assistive technology. Portaled layers live outside it. */
function syncInert() {
  if (typeof document === "undefined") return;
  const root = document.getElementById("app");
  if (!root) return;
  const blocking = stack.some((layer) => layer.kind === "modal" || layer.kind === "drawer");
  if (blocking) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

// ---- Scroll lock ------------------------------------------------------------

let locks = 0;
let saved: { overflow: string; paddingRight: string } | undefined;

/** Reference-counted page scroll lock; returns its release. */
export function lockScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (locks++ === 0) {
    const body = document.body;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0 && saved) {
      document.body.style.overflow = saved.overflow;
      document.body.style.paddingRight = saved.paddingRight;
      saved = undefined;
    }
  };
}

// ---- Focus ----------------------------------------------------------------

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

/**
 * Trap Tab inside `panel` while `active()` says so; focus moves in on the
 * next frame (an [autofocus] child first) and returns to the previously
 * focused element on release.
 */
export function trapFocus(panel: HTMLElement, active: () => boolean): () => void {
  const previous = document.activeElement as HTMLElement | null;
  const raf = requestAnimationFrame(() => {
    if (!active() || panel.contains(document.activeElement)) return;
    (panel.querySelector<HTMLElement>("[autofocus]") || focusables(panel)[0] || panel).focus({ preventScroll: true });
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !active() || event.defaultPrevented) return;
    const items = focusables(panel);
    const first = items[0] || panel;
    const last = items.at(-1) || panel;
    const current = document.activeElement;
    if (!panel.contains(current) || current === panel || (event.shiftKey && current === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey);
  return () => {
    cancelAnimationFrame(raf);
    document.removeEventListener("keydown", onKey);
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };
}
