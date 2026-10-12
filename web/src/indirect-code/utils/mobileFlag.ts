import { createSignal, onCleanup } from "solid-js";

/** The pre-paint touch-device flag lives on `html.mobile` (web/index.html):
 *  it is the single source of truth for "is this a phone/tablet" — CSS
 *  viewport heuristics are unreliable (a touch laptop or a small desktop
 *  window must keep desktop behavior). The script keeps the class in sync
 *  on resize/orientationchange; this signal reads it and FOLLOWS its
 *  updates so UI state can never diverge from the flag. */
export function readMobileFlag(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("mobile");
}

/** Solid signal mirroring `html.mobile`, including the script's updates. */
export function createMobileFlag(): () => boolean {
  const [isMobile, setIsMobile] = createSignal(readMobileFlag());
  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver(() => {
      const next = readMobileFlag();
      setIsMobile((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    onCleanup(() => observer.disconnect());
  }
  return isMobile;
}
