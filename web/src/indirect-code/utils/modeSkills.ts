import type { SkillConfig } from "../types";

/** The 4 legacy-mode skills (build/plan/learning/talk) as a TEMPORARY
 * frontend cache: they render the mode picker before the daemon's official
 * skill list arrives (config mirror). Once the official list is loaded it
 * is the source of truth — cache entries are adjusted from it (description,
 * mode, usable, approvalMode) and any that no longer exist there (deleted
 * or turned usable:"never", which the daemon omits) are hidden.
 *
 * Mode skills are special: exactly one of them is the session's PRIMARY
 * skill (lowest priority number, first in the selection) and its `mode:`
 * gives the session mode. If none of them exists on the daemon, there is
 * no mandatory primary — the mode comes from the first selected skill. */
export interface ModeSkillSpec {
  name: string;
  label: string;
  icon: string;
  mode: string;
  description: string;
  usable?: string;
  approvalMode?: string;
}

const MODE_SKILL_CACHE: ModeSkillSpec[] = [
  { name: "build", label: "Build", mode: "agentic", description: "Implement and validate changes", icon: "lucide:hammer" },
  { name: "plan", label: "Plan", mode: "agentic", description: "Explore and plan without editing files", icon: "lucide:list-checks" },
  { name: "talk", label: "Talk", mode: "talk", description: "Conversational agent with web research, no workspace access", icon: "lucide:messages-square", approvalMode: "yolo" },
  { name: "learning", label: "Learning", mode: "agentic", description: "Learn through hints and guiding questions", icon: "lucide:graduation-cap" },
];

export const MODE_SKILL_NAMES = MODE_SKILL_CACHE.map((m) => m.name);

export const isModeSkillName = (name: string) => MODE_SKILL_NAMES.includes(name);

/** The picker-ready mode skills. Before the official list loads this is the
 * plain cache; afterwards only the ones the daemon still has (present in
 * the list and not usable:"never"), with description/mode/usable/
 * approvalMode taken from the official entries. Label and icon stay
 * frontend-owned (the daemon list has neither). */
export function effectiveModeSkills(
  official: Record<string, SkillConfig> | undefined,
  loaded: boolean,
): ModeSkillSpec[] {
  if (!loaded) return MODE_SKILL_CACHE;
  const out: ModeSkillSpec[] = [];
  for (const cached of MODE_SKILL_CACHE) {
    const real = official?.[cached.name];
    if (!real || (real.usable ?? "inherit") === "never") continue;
    out.push({
      ...cached,
      description: real.description || cached.description,
      mode: real.mode || cached.mode,
      usable: real.usable,
      approvalMode: real.approvalMode,
    });
  }
  return out;
}

/** Enforces the primary-skill invariant on a selection: at most one mode
 * skill, always first (lowest priority). Mode skills that are not in
 * `available` (the effective mode skills) drop out; when none is selected
 * but some exist, the first available becomes primary. When no mode skill
 * exists at all, the selection is just the additional skills. */
export function ensureModeSkill(selection: string[], available: string[]): string[] {
  const rest = selection.filter((n) => !isModeSkillName(n));
  const chosen = selection.find((n) => isModeSkillName(n) && available.includes(n)) ?? available[0];
  return chosen ? [chosen, ...rest] : rest;
}

/** Collapses a skill `mode:` to the base session mode. Only agentic-shaped
 * values are workspace work; anything else (missing, invalid, "talk") is
 * conversational. */
export function baseMode(raw: string | undefined): "agentic" | "talk" {
  const m = (raw || "").toLowerCase();
  return m === "agentic" || m === "build" || m === "plan" || m === "learning" ? "agentic" : "talk";
}

/** The mode the frontend sends on create/configure: derived from the
 * lowest-priority (first) selected skill — normally the mode skill, but
 * simply the first additional skill when no mode skill exists. No
 * selection (or a first skill without a mode) falls back to "talk". */
export function deriveSessionMode(
  selection: string[],
  modeOf: (name: string) => string | undefined,
): "agentic" | "talk" {
  const first = selection[0];
  return first ? baseMode(modeOf(first)) : "talk";
}

/** True when a session usable override must ride the wire: only when it
 * differs from the skill file's original. "inherit"/unset means "follow
 * the original", so it never differs and the key is omitted (the daemon
 * inherits the file default from the missing key). */
export function usableDiffers(sessionUsable: string | undefined, originalUsable: string | undefined): boolean {
  if (!sessionUsable || sessionUsable === "inherit") return false;
  return sessionUsable !== (originalUsable || "inherit");
}
