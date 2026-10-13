import * as gsapNs from "gsap";

// The gsap module's primary export is an instance (`gsap` / default) whose
// API (to, from, timeline, ...) is NOT re-exported as named members of the
// module namespace. Widgets are documented to use `import * as gsap from
// "gsap"` and call `gsap.to(...)`, so the namespace must carry the instance
// API as named exports too. The named easings (Back, Bounce, ...) keep
// working both as namespace members and on the instance.
const instance: any = (gsapNs as any).gsap ?? (gsapNs as any).default;
(globalThis as any).gsap = instance;

export const {
  to,
  from,
  fromTo,
  set,
  timeline,
  delayedCall,
  killTweensOf,
  getTweensOf,
  getProperty,
  quickTo,
  quickSetter,
  isTweening,
  defaults,
  config,
  registerPlugin,
  registerEffect,
  registerEase,
  parseEase,
  getById,
  exportRoot,
  context,
  matchMedia,
  matchMediaRefresh,
  addEventListener,
  removeEventListener,
  install,
  updateRoot,
} = instance;

export * from "gsap";
export default instance;
