import type { DaemonCommand } from "../daemon-protocol";
import { normalizeSkillSelection } from "../utils/settingsValidation";
import { MODE_SKILL_NAMES, deriveSessionMode, ensureModeSkill, originalUsable, usableDiffers } from "../utils/modeSkills";
import { createSignal } from "solid-js";

/** Session options (model/effort/mode/skills/access) + reconciliation with the
 * daemon (extracted verbatim from RemoteCodePage). The FRONTEND owns mode
 * derivation and skill validation: the mode sent on create/configure comes
 * from the lowest-priority selected skill, and the daemon stores what it
 * receives (validating only the mode enum). */
export function createSessionOptions(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  /** Effective catalog lookup (official daemon list reconciled with the
   * mode-skill cache): a skill's original mode/usable, if known. */
  getSkill?: (name: string) => { mode?: string; usable?: string } | undefined;
  /** Mode-skill names currently available, in preference order (the
   * effective picker list). Defaults to the 4 cached names. */
  listModeSkills?: () => string[];
  /** The ACTIVE session's locked base mode: a session keeps the mode it
   * was created with, so for existing sessions the wire mode is always
   * this — never re-derived from the (possibly edited) selection.
   * Undefined in draft (creation derives from the primary skill). */
  getLockedMode?: () => "agentic" | "talk" | undefined;
}) {
  const [effort, setEffort] = createSignal("medium");
  // Base session mode display echo ("agentic" | "talk"). The value actually
  // sent is derived from the selection in sessionOptions(); this signal is
  // kept in sync from daemon snapshots and picker choices for the UI.
  const [agentMode, setAgentMode] = createSignal("agentic");
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([]);
  /** Resolved approval mode from the daemon ("ask" | "yolo"). "yolo" hides
   * the YOLO/ASK selector (spec 4.2). */
  const [approvalMode, setApprovalMode] = createSignal<"ask" | "yolo">("ask");
  const [activeModel, setActiveModel] = createSignal("");
  const [yoloMode, setYoloMode] = createSignal(true);
  const [modeMenuOpen, setModeMenuOpen] = createSignal(false);
  const [accessMenuOpen, setAccessMenuOpen] = createSignal(false);
  let modeBtn: HTMLButtonElement | undefined;
  let accessBtn: HTMLButtonElement | undefined;
  /** The selection with the primary-skill invariant applied: exactly one
   * available mode skill first (when any exists). */
  function ensuredSelection(sel: string[]): string[] {
    return ensureModeSkill(normalizeSkillSelection(sel), opts.listModeSkills?.() ?? MODE_SKILL_NAMES);
  }
  /** Applies the invariant to the live selection state (draft bootstrap:
   * a fresh draft with no mode skill picks the first available one). */
  function ensureSelection() {
    const next = ensuredSelection(selectedSkills());
    setSelectedSkills(next);
    setAgentMode(deriveSessionMode(next, (n) => opts.getSkill?.(n)?.mode));
    return next;
  }
  /** The wire usable for one skill: only present when the session value
   * differs from the skill file's original (omitted = inherit). */
  function usableEntry(name: string, value: string | undefined): { usable?: string } {
    return usableDiffers(value, opts.getSkill?.(name)?.usable) ? { usable: value } : {};
  }
  /** The mode the next create/configure will carry: the locked session
   * mode for an existing session, otherwise derived from the ensured
   * selection's lowest-priority skill. Drives draft UI (project picker
   * visibility) before anything is sent. */
  function pendingMode(): "agentic" | "talk" {
    return opts.getLockedMode?.() ?? deriveSessionMode(ensuredSelection(selectedSkills()), (n) => opts.getSkill?.(n)?.mode);
  }
  function sessionOptions() {
    // The wire carries the mode owned HERE: a session's locked mode once
    // it exists (mode never changes after creation), or the mode derived
    // from the lowest-priority selected skill for a new one. Plus ONLY
    // the active skills in priority order, each with usable only when it
    // differs from the original skill file.
    const selection = ensuredSelection(selectedSkills());
    return {
      effort: effort(),
      mode: pendingMode(),
      skills: selection.map((name) => ({ name, ...usableEntry(name, skillUsables()[name]) })),
      access: yoloMode() ? "full" : "ask",
    };
  }
  let lastLocalSelection: ReturnType<typeof sessionOptions> & { model: string } | undefined;
  let pendingSessionChoice: { sessionId: string; choice: ReturnType<typeof sessionOptions> & { model: string } } | undefined;
  function matchesChoice(a: any, b: any) {
    // skills are ignored here: the daemon echoes options.skills as [] (the
    // live selection travels as the session skill map snapshot instead).
    return a?.model === b?.model && a?.effort === b?.effort && a?.mode === b?.mode && a?.access === b?.access;
  }
  function configureSession() {
    lastLocalSelection = { model: activeModel(), ...sessionOptions() };
    pendingSessionChoice = opts.getSessionId() ? { sessionId: opts.getSessionId(), choice: lastLocalSelection } : undefined;
    opts.send({ type: "configure_session", sessionId: opts.getSessionId() || "", model: activeModel(), options: sessionOptions() });
  }

  function applyOptions(options: any) {
    setEffort(options?.effort || "medium");
    const mode = String(options?.mode || "").toLowerCase();
    setAgentMode(mode === "talk" ? "talk" : "agentic");
    // The live skill selection is NOT taken from options.skills (the daemon
    // echoes it empty): it arrives as the session skill map snapshot via
    // applySessionSkills. Only a pending local choice is authoritative here.
    setYoloMode(options?.access !== "ask");
  }
  /** Applies the daemon's resolved approval mode (session snapshot). */
  function applyApprovalMode(mode: string | undefined) {
    setApprovalMode(mode === "yolo" ? "yolo" : "ask");
    if (mode === "yolo") setYoloMode(true);
  }
  /** Per-skill usable override for the session ("inherit" | "ask" | "yolo" |
   * "deny"); "deny" = AI-hidden but user-activatable, "never" skills are
   * base-only and never appear here. */
  const [skillUsables, setSkillUsables] = createSignal<Record<string, string>>({});

  /** Applies the session skill map from the daemon snapshot (complete
   * replace): active skills ordered by priority become the selection, and
   * the per-skill usable overrides refresh. The snapshot's options.mode
   * (the mode this frontend sent) is applied by applyOptions. */
  function applySessionSkills(skills: Record<string, { priority?: number; active?: boolean; usable?: string }> | undefined) {
    const map: Record<string, string> = {};
    const active: { name: string; priority: number }[] = [];
    for (const [name, st] of Object.entries(skills || {})) {
      map[name] = st.usable || "inherit";
      if (st.active) active.push({ name, priority: st.priority ?? 0 });
    }
    active.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
    setSkillUsables(map);
    setSelectedSkills(active.map((s) => s.name));
  }

  /** Persists a granular skill edit (daemon `update_skills`): per-skill
   * set/unset of active + usable plus the full active order for
   * drag-to-sort. The daemon answers with a complete skills snapshot and
   * stores everything verbatim (usable locks are enforced ONLY here).
   * `usable` is sent only when it differs from the skill file's original
   * (omitted = inherit). The target selection passes the primary-skill
   * invariant (exactly one mode skill first, when any exists). Passing no
   * diff (pure reorder) sends an empty set/unset. */
  function syncSkills(next: string[], usables?: Record<string, string>) {
    const skills = ensuredSelection(next);
    const prev = selectedSkills();
    const prevSet = new Set(prev);
    const nextSet = new Set(skills);
    const set: Record<string, { active: boolean; usable?: string }> = {};
    for (const name of skills) {
      if (!prevSet.has(name)) {
        set[name] = { active: true, ...usableEntry(name, (usables ?? skillUsables())[name]) };
      }
    }
    const unset: string[] = [];
    for (const name of prev) {
      // Deactivation is a set{active:false} (a differing usable override
      // still rides along so it survives); `unset` stays reserved for
      // true removal from the session map.
      if (!nextSet.has(name)) set[name] = { active: false, ...usableEntry(name, (usables ?? skillUsables())[name]) };
    }
    if (usables) {
      for (const [name, usable] of Object.entries(usables)) {
        if (skillUsables()[name] !== usable && !set[name]) {
          set[name] = { active: nextSet.has(name), ...usableEntry(name, usable) };
        }
      }
    }
    setSelectedSkills(skills);
    if (usables) setSkillUsables(usables);
    const sid = opts.getSessionId();
    if (sid) opts.send({ type: "update_skills", sessionId: sid, set, unset, order: skills });
  }

  /** Cycles one skill's session usable override within the locks of the
   * skill file's ORIGINAL (usable table): only an "ask" original may be
   * pinned (ask/yolo/deny); deny/yolo/never originals — including a file
   * with no usable key, whose original is deny — are locked (static
   * badge). The session value "inherit" means "no override". */
  function cycleSkillUsable(name: string, defaultUsable?: string) {
    if (originalUsable(defaultUsable) !== "ask") return;
    const order = ["ask", "yolo", "deny"];
    const cur = skillUsables()[name] || "inherit";
    const idx = order.indexOf(cur);
    const next = order[idx < 0 ? 0 : (idx + 1) % order.length];
    const map = { ...skillUsables(), [name]: next };
    // syncSkills diffs `map` against the live skillUsables() signal and
    // applies the map itself — pre-setting the signal here would starve
    // that diff and the override would never reach the daemon.
    syncSkills(selectedSkills(), map);
  }

  /** Reconciles server selection from daemon (session_data): older configure
   * acks do not overwrite a newer local choice. */
  function reconcileServerSelection(sid: string, model: string | undefined, options: any, knownModelIds: string[], fallbackModelId: string) {
    // Older configure acknowledgements must not overwrite a newer choice
    // while multiple changes are travelling to/from the daemon.
    const pending = pendingSessionChoice?.sessionId === sid ? pendingSessionChoice : undefined;
    if (!pending || matchesChoice({ model, ...options }, pending.choice)) {
      pendingSessionChoice = undefined;
      if (model) setActiveModel(knownModelIds.some((m) => m === model) ? model : fallbackModelId);
      applyOptions(options);
    }
  }

  /** Session/host switch: forgets pending local choices. */
  function resetPending() {
    lastLocalSelection = undefined;
    pendingSessionChoice = undefined;
  }
  /** Closed socket: forgets only the pending ack (local selection survives). */
  function resetPendingChoice() {
    pendingSessionChoice = undefined;
  }
  function getLastLocalSelection() {
    return lastLocalSelection;
  }
  function clearLastLocalSelection() {
    lastLocalSelection = undefined;
  }

  return {
    effort, setEffort, agentMode, setAgentMode, selectedSkills, setSelectedSkills,
    approvalMode, applyApprovalMode, syncSkills, ensureSelection, pendingMode,
    skillUsables, applySessionSkills, cycleSkillUsable,
    activeModel, setActiveModel, yoloMode, setYoloMode,
    modeMenuOpen, setModeMenuOpen, accessMenuOpen, setAccessMenuOpen,
    modeBtn, accessBtn,
    sessionOptions, matchesChoice, configureSession, applyOptions,
    reconcileServerSelection, resetPending, resetPendingChoice, getLastLocalSelection, clearLastLocalSelection,
  };
}

export type SessionOptions = ReturnType<typeof createSessionOptions>;
