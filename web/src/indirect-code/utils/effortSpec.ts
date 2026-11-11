import { REASONING_LEVELS } from "../constants";
import { normalizeEffort } from "./format";

export type EffortLevel = (typeof REASONING_LEVELS)[number];

export interface EffortSpec {
  readonly level: EffortLevel;
  readonly title: string;
  readonly desc: string;
}

export const EFFORT_SPECS: readonly EffortSpec[] = [
  { level: "none", title: "Off", desc: "Responds immediately without extended thinking" },
  { level: "minimum", title: "Min", desc: "Minimal thinking for quick, routine tasks" },
  { level: "low", title: "Low", desc: "Light reasoning for everyday coding tasks" },
  { level: "medium", title: "Medium", desc: "Balances speed and reasoning depth" },
  { level: "high", title: "High", desc: "Thinks harder problems through" },
  { level: "xhigh", title: "X-High", desc: "Deep multi-step reasoning for complex problems" },
  { level: "max", title: "Max", desc: "The slowest and most thorough" },
] as const;

export function resolveEffortIndex(raw: string): number {
  const norm = normalizeEffort(raw) || "medium";
  const idx = EFFORT_SPECS.findIndex((s) => s.level === norm);
  return idx >= 0 ? idx : 3;
}

export function resolveEffortSpec(raw: string): EffortSpec {
  return EFFORT_SPECS[resolveEffortIndex(raw)]!;
}

export function clientXToEffortIndex(clientX: number, trackLeft: number, trackWidth: number): number {
  const span = Math.max(1, trackWidth - 28);
  const ratio = Math.min(1, Math.max(0, (clientX - trackLeft - 14) / span));
  return Math.round(ratio * (EFFORT_SPECS.length - 1));
}

export function stepEffortIndex(currentIdx: number, key: string): number | null {
  const last = EFFORT_SPECS.length - 1;
  switch (key) {
    case "ArrowLeft":
    case "ArrowDown":
      return Math.max(0, currentIdx - 1);
    case "ArrowRight":
    case "ArrowUp":
      return Math.min(last, currentIdx + 1);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
