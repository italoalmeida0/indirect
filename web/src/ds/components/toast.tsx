import { createEffect, createSignal, For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { animate } from "../motion/animate";
import { collapseHeight } from "../motion/morph";
import { motionTokens, tween } from "../motion/tokens";
import { Glyph } from "./icon";

/**
 * Toast stack (Arc "Toast stack"): brief confirmation for BACKGROUND
 * results. Foreground actions confirm in place (button label, copy check);
 * a toast is never the only confirmation of something the user just did on
 * screen. Toasts glide down from top-right on spring.smooth, pause while
 * hovered or focused, deduplicate in place, and can be swiped away.
 */
export type ToastKind = "ok" | "err";

export interface ToastItem {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
  readonly rev: number;
}

interface ToastEntry extends ToastItem {
  bump: () => void;
  leaving: boolean;
}

const [items, setItems] = createSignal<ToastEntry[]>([]);
let nextId = 0;

export function toastDuration(kind: ToastKind): number {
  return kind === "err" ? 6500 : 3200;
}

/** Read-only signal accessor of currently active toasts (used in tests). */
export function activeToasts(): readonly ToastItem[] {
  return items();
}

/** Immediately clear the toast stack (used in tests). */
export function clearToasts(): void {
  setItems([]);
}

/** Show a toast. Errors are announced assertively. */
export function pushToast(text: string, kind: ToastKind = "ok"): void {
  if (typeof text !== "string" || !text.trim()) return;
  const current = items();
  const existing = current.find(
    (item) => !item.leaving && item.kind === kind && item.text === text,
  );
  if (existing) {
    existing.bump();
    return;
  }
  const [rev, setRev] = createSignal(1);
  const id = ++nextId;
  const entry: ToastEntry = {
    id,
    kind,
    text,
    get rev() {
      return rev();
    },
    bump() {
      setRev((r) => r + 1);
    },
    leaving: false,
  };
  const visible = current.filter((item) => !item.leaving);
  const leavingItems = current.filter((item) => item.leaving);
  setItems([...leavingItems, ...visible.slice(-2), entry]);
}

function dismiss(id: number) {
  setItems((list) => list.filter((item) => item.id !== id));
}

function ToastView(props: { item: ToastEntry }) {
  let el!: HTMLDivElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remaining = toastDuration(props.item.kind);
  let startedAt = 0;
  let leaving = false;
  let hovered = false;
  let focused = false;
  let mounted = false;

  // Swipe to dismiss (touch and mouse), with a button path for everyone.
  let dragX = 0;
  let pointer: number | undefined;
  const isPaused = () => hovered || focused || pointer !== undefined;

  const leave = (direction = 0) => {
    if (leaving) return;
    leaving = true;
    props.item.leaving = true;
    clearTimeout(timer);
    timer = undefined;
    const slide = direction ? `${direction * 120}%` : "0px";
    void animate(el, { opacity: "0", transform: `translateX(${slide}) scale(0.98)` }, tween.exit).finished
      .then(() => collapseHeight(el).finished)
      .then(() => dismiss(props.item.id));
  };
  const start = () => {
    if (leaving || isPaused()) return;
    clearTimeout(timer);
    startedAt = Date.now();
    timer = setTimeout(() => leave(), remaining);
  };
  const pause = () => {
    if (leaving || timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
  };

  createEffect(() => {
    const rev = props.item.rev;
    if (!mounted || rev <= 1 || leaving) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = toastDuration(props.item.kind);
    if (!isPaused()) start();
  });

  const onDown = (event: PointerEvent) => {
    if ((event.target as HTMLElement).closest("button")) return;
    pointer = event.pointerId;
    dragX = event.clientX;
    el.setPointerCapture(event.pointerId);
    pause();
  };
  const onMove = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return;
    const dx = Math.max(0, event.clientX - dragX);
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.3, 1 - dx / 240));
  };
  const onUp = (event: PointerEvent) => {
    if (pointer !== event.pointerId) return;
    pointer = undefined;
    const dx = event.clientX - dragX;
    if (dx > 80) leave(1);
    else {
      animate(el, { transform: "none", opacity: "1" }, motionTokens.spring.snappy);
      start();
    }
  };

  onMount(() => {
    mounted = true;
    animate(el, { opacity: "1" }, { duration: motionTokens.duration.fast, ease: motionTokens.ease.enter }, { from: { opacity: "0" } });
    animate(el, { transform: "none" }, motionTokens.spring.smooth, { from: { transform: "translateY(-8px) scale(0.985)" } });
    start();
  });
  onCleanup(() => clearTimeout(timer));

  return (
    <div
      ref={el}
      role={props.item.kind === "err" ? "alert" : "status"}
      aria-live={props.item.kind === "err" ? "assertive" : "polite"}
      class={`ui-toast ui-toast-${props.item.kind}`}
      onMouseEnter={() => { hovered = true; pause(); }}
      onMouseLeave={() => { hovered = false; start(); }}
      onFocusIn={() => { focused = true; pause(); }}
      onFocusOut={() => { focused = false; start(); }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <span class="ui-toast-icon" aria-hidden="true">
        <Glyph icon={props.item.kind === "ok" ? "lucide:check" : "lucide:alert-circle"} size={14} />
      </span>
      <span class="ui-toast-text">{props.item.text}</span>
      <button type="button" class="ui-toast-close" aria-label="Dismiss notification" data-tip="Dismiss" onClick={() => leave(1)}>
        <Glyph icon="lucide:x" size={13} />
      </button>
    </div>
  );
}

/** Mount once at the app root. Portaled so modal inertness never reaches it. */
export function ToastRegion() {
  return (
    <Portal>
      <div role="region" class="ui-toast-region" aria-label="Notifications">
        <For each={items()}>{(item) => <ToastView item={item} />}</For>
      </div>
    </Portal>
  );
}
