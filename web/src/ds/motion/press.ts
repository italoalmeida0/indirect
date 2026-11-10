import { onCleanup } from "solid-js";

import { animate } from "./animate";
import { motionTokens } from "./tokens";

/**
 * Press feedback: the element sinks to ~0.97 on pointer down and settles
 * back on a snappy spring. Icon-sized controls press a little deeper and
 * wide ones a little less, so every size reads as the same push.
 *
 * Elements that anchor a floating layer (aria-haspopup, aria-expanded,
 * role=combobox) answer with color only: the popup positions against the
 * pressed size. Keyboard and reduced motion get no scale.
 */
export function press(el: HTMLElement): void {
  if (typeof window === "undefined") return;
  let pressed = false;
  const anchorsPopup = () =>
    el.matches('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded], [role="combobox"]');
  const depth = () => {
    const width = el.offsetWidth;
    return width > 220 ? 0.985 : width && width <= 48 ? 0.96 : 0.97;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || (el as HTMLButtonElement).disabled || anchorsPopup()) return;
    pressed = true;
    animate(el, { scale: String(depth()) }, { duration: motionTokens.duration.instant, ease: motionTokens.ease.standard });
  };
  const up = () => {
    if (!pressed) return;
    pressed = false;
    animate(el, { scale: "1" }, motionTokens.spring.snappy);
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointerleave", up);
  el.addEventListener("pointercancel", up);
  onCleanup(() => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointerleave", up);
    el.removeEventListener("pointercancel", up);
  });
}
