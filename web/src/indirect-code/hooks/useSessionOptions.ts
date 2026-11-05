import type { DaemonCommand } from "../daemon-protocol";
import { normalizeSkillSelection } from "../utils/settingsValidation";
import { MODE_SKILL_NAMES, baseMode, deriveSessionMode, ensureModeSkill, isModeSkillName, usableDiffers } from "../utils/modeSkills";
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
  const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([], { equals: arraysEqual });
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
    const current = selectedSkills();
    const next = ensuredSelection(current);
    if (!arraysEqual(current, next)) {
      setSelectedSkills(next);
    }
    const derived = deriveSessionMode(next, (n) => opts.getSkill?.(n)?.mode);
    if (agentMode() !== derived) {
      setAgentMode(derived);
    }
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
  const recordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  };
  const [skillUsables, setSkillUsables] = createSignal<Record<string, string>>({}, { equals: recordsEqual });
  /** True once the current draft's skill selection is settled (seeded from
   * the remembered choice, or edited by the user): later config refreshes
   * must not reseed it. Reset when a session snapshot takes over. */
  let draftSeeded = false;

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
    // Same tie-break as the daemon's Resolve (byte order of the name), so
    // the primary skill shown here is the one the daemon resolves.
    active.sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    setSkillUsables(map);
    setSelectedSkills(ensuredSelection(active.map((s) => s.name)));
    draftSeeded = false;
    pendingSkillSync = undefined;
  }

  /** An update_skills in flight: mirror rows pulled before the daemon
   * applied it still carry the old map, so they must not revert the local
   * edit. The daemon answers every update_skills with a complete
   * session_data (applySessionSkills), which ends the wait; the deadline
   * only covers a lost reply. */
  let pendingSkillSync: { sessionId: string; until: number } | undefined;
  const SKILL_SYNC_GRACE_MS = 5000;

  /** Mirror-row variant of applySessionSkills: skipped while a local edit
   * of this session is still travelling to the daemon. */
  function applyMirrorSessionSkills(sessionId: string, skills: Parameters<typeof applySessionSkills>[0]) {
    if (pendingSkillSync && pendingSkillSync.sessionId === sessionId && Date.now() < pendingSkillSync.until) return;
    applySessionSkills(skills);
  }

  /** Starts a draft from a clean slate: the previous session's selection,
   * usable overrides and approval mode never carry over. The primary skill
   * comes from the remembered choice (its mode skill, or one matching its
   * mode); additional skills are per conversation and start empty. With
   * `force` false this only seeds a draft nobody settled yet (config
   * refreshes must not undo an in-draft pick). */
  function resetDraftSkills(remembered?: { mode?: string; skills?: { name: string }[] } | null, force = true) {
    if (!force && draftSeeded) {
      ensureSelection();
      return;
    }
    const available = opts.listModeSkills?.() ?? MODE_SKILL_NAMES;
    const rememberedNames = (remembered?.skills ?? []).map((s) => (typeof s === "string" ? s : s?.name)).filter(Boolean) as string[];
    const primary =
      rememberedNames.find((n) => isModeSkillName(n) && available.includes(n)) ??
      (remembered?.mode ? available.find((n) => baseMode(opts.getSkill?.(n)?.mode) === baseMode(remembered.mode)) : undefined);
    setSkillUsables({});
    setApprovalMode("ask");
    setSelectedSkills(primary ? [primary] : []);
    ensureSelection();
    draftSeeded = !!primary;
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
    // Ensure mutual exclusion between base modes (build, plan, learning,
    // talk): a mode skill the session map still knows (it has an entry,
    // active or not, in the last snapshot) and that is not the chosen one
    // is explicitly deactivated. Mode skills the session never had need no
    // entry — sending {active:false} for them only bloats the map.
    const modeSkillsList = opts.listModeSkills?.() ?? MODE_SKILL_NAMES;
    for (const m of modeSkillsList) {
      if (!nextSet.has(m) && !set[m] && m in skillUsables()) {
        set[m] = { active: false, ...usableEntry(m, (usables ?? skillUsables())[m]) };
      }
    }
    if (usables) {
      for (const [name, usable] of Object.entries(usables)) {
        // "inherit" and unset are the same session value (no override).
        if ((skillUsables()[name] || "inherit") !== (usable || "inherit") && !set[name]) {
          set[name] = { active: nextSet.has(name), ...usableEntry(name, usable) };
        }
      }
    }
    setSelectedSkills(skills);
    if (usables) setSkillUsables(usables);
    const sid = opts.getSessionId();
    if (sid) {
      pendingSkillSync = { sessionId: sid, until: Date.now() + SKILL_SYNC_GRACE_MS };
      opts.send({ type: "update_skills", sessionId: sid, set, unset, order: skills });
    } else draftSeeded = true; // an in-draft pick is the user's: keep it
  }

  /** Clears every per-session skill state (host switch: nothing from the
   * previous daemon may bleed through until a session or draft takes over). */
  function resetSkillState() {
    setSkillUsables({});
    setApprovalMode("ask");
    setSelectedSkills([]);
    draftSeeded = false;
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
    skillUsables, applySessionSkills, applyMirrorSessionSkills, resetDraftSkills, resetSkillState,
    activeModel, setActiveModel, yoloMode, setYoloMode,
    modeMenuOpen, setModeMenuOpen, accessMenuOpen, setAccessMenuOpen,
    modeBtn, accessBtn,
    sessionOptions, matchesChoice, configureSession, applyOptions,
    reconcileServerSelection, resetPending, resetPendingChoice, getLastLocalSelection, clearLastLocalSelection,
  };
}

export type SessionOptions = ReturnType<typeof createSessionOptions>;
