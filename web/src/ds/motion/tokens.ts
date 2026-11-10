/**
 * Motion vocabulary shared by every component (the same values Arc uses).
 *
 *  - spring.smooth: panels, height, drawers, progress, anything that reports
 *    state. Critically damped, never overshoots.
 *  - spring.snappy: presses, toggles, thumbs, small indicators, icon swaps.
 *  - spring.morph:  shared highlights that glide between options, width that
 *    follows new content, shape morphs.
 *  - duration/ease: tweens for color, opacity and small fades. Exits are
 *    faster than entrances.
 *
 * CSS transitions use the matching custom properties from ds/tokens.css
 * (--duration-*, --ease-*).
 */
export interface SpringTransition {
  type: "spring";
  /** Perceived duration in seconds (time to visually settle). */
  visualDuration: number;
  /** 0 = critically damped (no overshoot); > 0 adds visible bounce. */
  bounce: number;
  delay?: number;
}

export interface TweenTransition {
  type?: "tween";
  /** Seconds. */
  duration: number;
  /** Cubic-bezier control points or any CSS easing string. */
  ease?: readonly [number, number, number, number] | string;
  delay?: number;
}

export type Transition = SpringTransition | TweenTransition;

export const motionTokens = {
  duration: { instant: 0.1, fast: 0.13, exit: 0.14, standard: 0.19, considered: 0.36 },
  ease: {
    enter: [0.16, 1, 0.3, 1] as const,
    exit: [0.7, 0, 0.84, 0] as const,
    standard: [0.22, 1, 0.36, 1] as const,
    /** For elements that move while already on screen. */
    inOut: [0.65, 0, 0.35, 1] as const,
  },
  spring: {
    snappy: { type: "spring", visualDuration: 0.19, bounce: 0 } as SpringTransition,
    smooth: { type: "spring", visualDuration: 0.26, bounce: 0 } as SpringTransition,
    morph: { type: "spring", visualDuration: 0.28, bounce: 0 } as SpringTransition,
    /** Playful moments only (a reaction, a celebration). Never routine UI. */
    playful: { type: "spring", visualDuration: 0.38, bounce: 0.25 } as SpringTransition,
  },
  /** Stagger steps in seconds. Keep the total under roughly 0.4s. */
  stagger: { char: 0.016, word: 0.04, line: 0.08, item: 0.035 },
  /** Blur radii in px for brief text and content crossfades. */
  blur: { subtle: 2, soft: 4, text: 8 },
} as const;

/** Tween helpers for the common cases. */
export const tween = {
  fast: { duration: motionTokens.duration.fast, ease: motionTokens.ease.standard } as TweenTransition,
  instant: { duration: motionTokens.duration.instant, ease: motionTokens.ease.standard } as TweenTransition,
  exit: { duration: motionTokens.duration.exit, ease: motionTokens.ease.exit } as TweenTransition,
  enter: { duration: motionTokens.duration.standard, ease: motionTokens.ease.enter } as TweenTransition,
};
