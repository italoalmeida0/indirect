import { createSignal, For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import { animate } from "../motion/animate";
import { collapseHeight } from "../motion/morph";
import { motionTokens, tween } from "../motion/tokens";
import { Glyph } from "./icon";

/**
 * Toast stack (Arc "Toast stack"): brief confirmation for BACKGROUND
 * results. Foreground actions confirm in place (button label, copy check);
 * a toast is never the only confirmation of something the user just did on
 * screen. Toasts rise in on spring.smooth, pause while hovered or focused,
 * can be swiped away, and the gap closes smoothly when one leaves.
 */
export type ToastKind = "ok" | "err";

interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

const [items, setItems] = createSignal<ToastItem[]>([]);
let nextId = 0;
const DURATION = 4000;

/** Show a toast. Errors are announced assertively. */
export function pushToast(text: string, kind: ToastKind = "ok"): void {
  const id = ++nextId;
  setItems((list) => [...list.slice(-3), { id, kind, text }]);
}

function dismiss(id: number) {
  setItems((list) => list.filter((item) => item.id !== id));
}

function ToastView(props: { item: ToastItem }) {
  let el!: HTMLDivElement;
  let timer = 0;
  let remaining = DURATION;
  let startedAt = 0;
  let leaving = false;

  const leave = (direction = 0) => {
    if (leaving) return;
    leaving = true;
    window.clearTimeout(timer);
    const slide = direction ? `${direction * 120}%` : "0px";
    void animate(el, { opacity: "0", transform: `translateX(${slide}) scale(0.98)` }, tween.exit).finished
      .then(() => collapseHeight(el).finished)
      .then(() => dismiss(props.item.id));
  };
  const start = () => {
    startedAt = Date.now();
    timer = window.setTimeout(() => leave(), remaining);
  };
  const pause = () => {
    window.clearTimeout(timer);
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
  };

  // Swipe to dismiss (touch and mouse), with a button path for everyone.
  let dragX = 0;
  let pointer: number | undefined;
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
    animate(el, { opacity: "1" }, { duration: motionTokens.duration.fast, ease: motionTokens.ease.enter }, { from: { opacity: "0" } });
    animate(el, { transform: "none" }, motionTokens.spring.smooth, { from: { transform: "translateY(10px) scale(0.98)" } });
    start();
  });
  onCleanup(() => window.clearTimeout(timer));

  return (
    <div
      ref={el}
      role={props.item.kind === "err" ? "alert" : "status"}
      aria-live={props.item.kind === "err" ? "assertive" : "polite"}
      class={`ui-toast ui-toast-${props.item.kind}`}
      onMouseEnter={pause}
      onMouseLeave={() => { if (!leaving && pointer === undefined) start(); }}
      onFocusIn={pause}
      onFocusOut={() => { if (!leaving) start(); }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <span class="ui-toast-icon" aria-hidden="true">
        <Glyph icon={props.item.kind === "ok" ? "lucide:check" : "lucide:alert-circle"} size={16} />
      </span>
      <span class="ui-toast-text">{props.item.text}</span>
      <button type="button" class="ui-toast-close" aria-label="Dismiss notification" data-tip="Dismiss" onClick={() => leave(1)}>
        <Glyph icon="lucide:x" size={14} />
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
