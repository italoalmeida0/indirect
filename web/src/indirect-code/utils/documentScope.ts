import { onCleanup } from "solid-js";

let scopeRefCount = 0;

const TWEEN_DURATION_MS = 160;
const RAIL_PROXIMITY_PX = 16;

interface ScrollAxes {
  vert: boolean;
  horiz: boolean;
}

interface BoxEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ChannelTween {
  value: number;
  from: number;
  to: number;
  start: number;
  duration: number;
}

interface ScrollerAnimState {
  alpha: ChannelTween;
  expand: ChannelTween;
  hovered: boolean;
}

let controllerInstalled = false;
let rafId = 0;
let draggedEl: HTMLElement | null = null;
let prevPointerValid = false;
let prevPointerX = -1;
let prevPointerY = -1;
const scrollerStates = new Map<HTMLElement, ScrollerAnimState>();

function makeChannel(initial: number): ChannelTween {
  return { value: initial, from: initial, to: initial, start: 0, duration: 0 };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function setChannelTarget(ch: ChannelTween, target: number, now: number, instant: boolean): void {
  if (instant) {
    ch.value = target;
    ch.from = target;
    ch.to = target;
    ch.duration = 0;
    return;
  }
  if (ch.to === target) return;
  const dist = Math.abs(target - ch.value);
  if (dist < 0.005) {
    ch.value = target;
    ch.from = target;
    ch.to = target;
    ch.duration = 0;
    return;
  }
  ch.from = ch.value;
  ch.to = target;
  ch.start = now;
  ch.duration = Math.max(16, dist * TWEEN_DURATION_MS);
}

function stepChannel(ch: ChannelTween, now: number): boolean {
  if (ch.duration <= 0 || ch.value === ch.to) {
    ch.value = ch.to;
    ch.duration = 0;
    return false;
  }
  const elapsed = Math.max(0, now - ch.start);
  if (elapsed >= ch.duration) {
    ch.value = ch.to;
    ch.duration = 0;
    return false;
  }
  const u = elapsed / ch.duration;
  const eased = u * u * (3 - 2 * u);
  const next = ch.from + (ch.to - ch.from) * eased;
  if (Math.abs(ch.to - next) < 0.005) {
    ch.value = ch.to;
    ch.duration = 0;
    return false;
  }
  ch.value = next;
  return true;
}

function formatThumbColor(alpha: number, expand: number): string {
  if (alpha <= 0.001) return "transparent";
  let base: string;
  if (expand <= 0.001) {
    base = "var(--border-strong)";
  } else if (expand >= 0.999) {
    base = "var(--text-muted)";
  } else {
    base = `color-mix(in oklab, var(--text-muted) ${(expand * 100).toFixed(1)}%, var(--border-strong))`;
  }
  if (alpha >= 0.999) return base;
  return `color-mix(in oklab, ${base} ${(alpha * 100).toFixed(1)}%, transparent)`;
}

function applyScrollerStyle(el: HTMLElement, state: ScrollerAnimState): void {
  const pad = 3 - 2 * state.expand.value;
  const padStr = Number.isInteger(pad) ? `${pad}px` : `${pad.toFixed(3)}px`;
  el.style.setProperty("--rc-sb-pad", padStr);
  el.style.setProperty("--rc-scrollbar-thumb", formatThumbColor(state.alpha.value, state.expand.value));
}

function clearScrollerStyle(el: HTMLElement): void {
  el.style.removeProperty("--rc-scrollbar-thumb");
  el.style.removeProperty("--rc-sb-pad");
  if (el.getAttribute("style") === "") {
    el.removeAttribute("style");
  }
}

function isHiddenScrollbar(el: HTMLElement): boolean {
  const cls = el.classList;
  if (cls.contains("no-scrollbar") || cls.contains("ui-segmented") || cls.contains("ui-tabs-list")) {
    return true;
  }
  const raw = typeof el.className === "string" ? el.className : "";
  return raw.includes("scrollbar-width:none") || raw.includes("::-webkit-scrollbar]:hidden");
}

function getScrollAxes(el: HTMLElement): ScrollAxes | null {
  const overY = el.scrollHeight > el.clientHeight;
  const overX = el.scrollWidth > el.clientWidth;
  if (!overY && !overX) return null;
  if (isHiddenScrollbar(el)) return null;

  const cs = getComputedStyle(el);
  const oy = cs.overflowY;
  const ox = cs.overflowX;
  const isRoot = el === document.documentElement;
  const vert =
    overY &&
    (isRoot ? oy !== "hidden" && oy !== "clip" : oy === "auto" || oy === "scroll" || oy === "overlay");
  const horiz =
    overX &&
    (isRoot ? ox !== "hidden" && ox !== "clip" : ox === "auto" || ox === "scroll" || ox === "overlay");
  if (!vert && !horiz) return null;
  return { vert, horiz };
}

function getScrollerEdges(el: HTMLElement): BoxEdges {
  if (el === document.documentElement) {
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

function pointInBox(x: number, y: number, b: BoxEdges): boolean {
  return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
}

function isInRailZone(
  clientX: number,
  clientY: number,
  el: HTMLElement,
  axes: ScrollAxes,
  box: BoxEdges,
): boolean {
  let borderRight = 0;
  let borderBottom = 0;
  let borderTop = 0;
  let borderLeft = 0;
  if (el !== document.documentElement) {
    const cs = getComputedStyle(el);
    borderRight = parseFloat(cs.borderRightWidth) || 0;
    borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    borderTop = parseFloat(cs.borderTopWidth) || 0;
    borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  }
  const innerRight = box.right - borderRight;
  const innerBottom = box.bottom - borderBottom;
  const innerTop = box.top + borderTop;
  const innerLeft = box.left + borderLeft;

  if (
    axes.vert &&
    clientX >= innerRight - RAIL_PROXIMITY_PX &&
    clientX <= box.right + 1 &&
    clientY >= innerTop &&
    clientY <= innerBottom
  ) {
    return true;
  }
  if (
    axes.horiz &&
    clientY >= innerBottom - RAIL_PROXIMITY_PX &&
    clientY <= box.bottom + 1 &&
    clientX >= innerLeft &&
    clientX <= innerRight
  ) {
    return true;
  }
  return false;
}

function collectHoveredScrollers(
  startNode: EventTarget | null,
  clientX: number,
  clientY: number,
): Map<HTMLElement, { axes: ScrollAxes; box: BoxEdges; inRail: boolean }> {
  const found = new Map<HTMLElement, { axes: ScrollAxes; box: BoxEdges; inRail: boolean }>();
  let cur: Node | null = startNode instanceof Node ? startNode : null;
  while (cur && !(cur instanceof HTMLElement)) {
    cur = cur.parentNode;
  }
  while (cur instanceof HTMLElement) {
    if (!found.has(cur)) {
      const axes = getScrollAxes(cur);
      if (axes) {
        const box = getScrollerEdges(cur);
        if (pointInBox(clientX, clientY, box)) {
          found.set(cur, { axes, box, inRail: isInRailZone(clientX, clientY, cur, axes, box) });
        }
      }
    }
    if (cur.classList.contains("tarnav-codeblock")) {
      const wrapBox = getScrollerEdges(cur);
      if (pointInBox(clientX, clientY, wrapBox)) {
        for (let i = 0; i < cur.children.length; i++) {
          const child = cur.children[i];
          if (child instanceof HTMLElement && child.classList.contains("font-mono") && !found.has(child)) {
            const childAxes = getScrollAxes(child);
            if (childAxes) {
              const childBox = getScrollerEdges(child);
              found.set(child, {
                axes: childAxes,
                box: childBox,
                inRail: isInRailZone(clientX, clientY, child, childAxes, childBox),
              });
            }
          }
        }
      }
    }
    if (cur === document.documentElement) break;
    cur = cur.parentElement;
  }
  return found;
}

function tickScrollbarTweens(now: number): void {
  rafId = 0;
  let anyActive = false;

  for (const [el, state] of scrollerStates) {
    if (!el.isConnected) {
      clearScrollerStyle(el);
      scrollerStates.delete(el);
      if (draggedEl === el) draggedEl = null;
      continue;
    }
    const alphaMoving = stepChannel(state.alpha, now);
    const expandMoving = stepChannel(state.expand, now);

    if (!state.hovered && el !== draggedEl && state.alpha.value <= 0 && state.expand.value <= 0) {
      clearScrollerStyle(el);
      scrollerStates.delete(el);
      continue;
    }

    applyScrollerStyle(el, state);
    if (alphaMoving || expandMoving) {
      anyActive = true;
    }
  }

  if (anyActive) {
    rafId = requestAnimationFrame(tickScrollbarTweens);
  }
}

function ensureRaf(): void {
  if (rafId === 0) {
    rafId = requestAnimationFrame(tickScrollbarTweens);
  }
}

function syncHoveredTargets(
  hovered: Map<HTMLElement, { axes: ScrollAxes; box: BoxEdges; inRail: boolean }>,
  clientX: number,
  clientY: number,
  hasPoint: boolean,
): void {
  if (document.documentElement.classList.contains("mobile")) return;
  const now = performance.now();
  const instant = prefersReducedMotion();
  let needsRaf = false;

  for (const [el, info] of hovered) {
    let state = scrollerStates.get(el);
    if (!state) {
      const alreadyHovered = prevPointerValid && pointInBox(prevPointerX, prevPointerY, info.box);
      state = {
        alpha: makeChannel(alreadyHovered ? 1 : 0),
        expand: makeChannel(0),
        hovered: true,
      };
      scrollerStates.set(el, state);
    } else {
      state.hovered = true;
    }

    const expandTarget = info.inRail || el === draggedEl ? 1 : 0;
    setChannelTarget(state.alpha, 1, now, instant);
    setChannelTarget(state.expand, expandTarget, now, instant);
    applyScrollerStyle(el, state);
    if (state.alpha.duration > 0 || state.expand.duration > 0) {
      needsRaf = true;
    }
  }

  if (draggedEl && !hovered.has(draggedEl)) {
    if (!draggedEl.isConnected) {
      draggedEl = null;
    } else {
      let state = scrollerStates.get(draggedEl);
      if (!state) {
        state = { alpha: makeChannel(1), expand: makeChannel(1), hovered: false };
        scrollerStates.set(draggedEl, state);
      } else {
        state.hovered = false;
      }
      setChannelTarget(state.alpha, 1, now, instant);
      setChannelTarget(state.expand, 1, now, instant);
      applyScrollerStyle(draggedEl, state);
      if (state.alpha.duration > 0 || state.expand.duration > 0) {
        needsRaf = true;
      }
    }
  }

  for (const [el, state] of scrollerStates) {
    if (hovered.has(el) || el === draggedEl) continue;
    state.hovered = false;
    setChannelTarget(state.alpha, 0, now, instant);
    setChannelTarget(state.expand, 0, now, instant);
    if (state.alpha.value <= 0 && state.expand.value <= 0) {
      clearScrollerStyle(el);
      scrollerStates.delete(el);
    } else {
      applyScrollerStyle(el, state);
      if (state.alpha.duration > 0 || state.expand.duration > 0) {
        needsRaf = true;
      }
    }
  }

  if (hasPoint) {
    prevPointerValid = true;
    prevPointerX = clientX;
    prevPointerY = clientY;
  } else {
    prevPointerValid = false;
  }

  if (needsRaf) {
    ensureRaf();
  }
}

function onPointerMove(e: PointerEvent): void {
  if (document.documentElement.classList.contains("mobile")) return;
  if (draggedEl && (e.buttons & 1) === 0) {
    draggedEl = null;
  }
  const hovered = collectHoveredScrollers(e.target, e.clientX, e.clientY);
  syncHoveredTargets(hovered, e.clientX, e.clientY, true);
}

function onPointerDown(e: PointerEvent): void {
  if (document.documentElement.classList.contains("mobile") || e.button !== 0) return;
  const hovered = collectHoveredScrollers(e.target, e.clientX, e.clientY);
  draggedEl = null;
  for (const [el, info] of hovered) {
    if (info.inRail) {
      draggedEl = el;
      break;
    }
  }
  syncHoveredTargets(hovered, e.clientX, e.clientY, true);
}

function onPointerUp(e: PointerEvent): void {
  if (document.documentElement.classList.contains("mobile")) return;
  draggedEl = null;
  // Native scrollbar capture keeps `e.target` bound to the scroller even if
  // the pointer released outside its bounds; hit-test the actual release point.
  const hit =
    Number.isFinite(e.clientX) && Number.isFinite(e.clientY)
      ? document.elementFromPoint(e.clientX, e.clientY)
      : null;
  const hovered = hit ? collectHoveredScrollers(hit, e.clientX, e.clientY) : new Map();
  syncHoveredTargets(hovered, e.clientX, e.clientY, Boolean(hit));
}

function onPointerLeaveAll(): void {
  draggedEl = null;
  syncHoveredTargets(new Map(), -1, -1, false);
}

function startScrollbarController(): void {
  if (controllerInstalled || typeof window === "undefined") return;
  if (document.documentElement.classList.contains("mobile")) return;
  controllerInstalled = true;
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });
  window.addEventListener("pointercancel", onPointerLeaveAll, { passive: true });
  window.addEventListener("blur", onPointerLeaveAll, { passive: true });
  document.documentElement.addEventListener("mouseleave", onPointerLeaveAll, { passive: true });
}

function stopScrollbarController(): void {
  if (!controllerInstalled) return;
  controllerInstalled = false;
  if (rafId !== 0) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerLeaveAll);
  window.removeEventListener("blur", onPointerLeaveAll);
  document.documentElement.removeEventListener("mouseleave", onPointerLeaveAll);
  for (const [el] of scrollerStates) {
    clearScrollerStyle(el);
  }
  scrollerStates.clear();
  draggedEl = null;
  prevPointerValid = false;
}

/**
 * Marks `document.documentElement` with `data-indirect-code=""` and runs the
 * desktop scrollbar hover/rail-proximity animator while at least one Indirect
 * Code shell (`WorkspaceShell` or `CodeDevPage`) is mounted, covering all
 * workspace scroll containers and `<Portal>` overlays without affecting
 * Gateway screens or mobile touch scrollbars.
 */
export function useIndirectCodeDocumentScope(): void {
  if (typeof document === "undefined") return;
  let active = true;
  scopeRefCount += 1;
  document.documentElement.setAttribute("data-indirect-code", "");
  startScrollbarController();
  onCleanup(() => {
    if (!active) return;
    active = false;
    scopeRefCount = Math.max(0, scopeRefCount - 1);
    if (scopeRefCount === 0) {
      stopScrollbarController();
      document.documentElement.removeAttribute("data-indirect-code");
    }
  });
}
