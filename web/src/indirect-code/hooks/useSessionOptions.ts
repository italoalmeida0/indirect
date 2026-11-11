import type { DaemonCommand } from "../daemon-protocol";
import { normalizeEffort } from "../utils/format";
import { normalizeSkillSelection } from "../utils/settingsValidation";
import {
  MODE_SKILL_NAMES,
  baseMode,
  deriveSessionMode,
  effectiveModeSkills,
  ensureModeSkill,
  isModeSkillName,
  usableDiffers,
} from "../utils/modeSkills";
import { batch, createSignal, untrack } from "solid-js";

const PENDING_SYNC_TTL_MS = 8000;

interface MirrorSyncMeta {
  rowRef?: unknown;
  updatedAt?: number;
}

interface CausalPullClock {
  /** Monotonic local mutation/ack clock, bumped by caller on writes/acks. */
  nextClock: () => number;
  /** Highest clock value present when a completed pull for `collection` was initiated. */
  confirmedClock: (collection: "sessions" | "config") => number;
}

function pushDistinct<T>(queue: T[], next: T, eq: (a: T, b: T) => boolean): T[] {
  if (queue.length > 0 && eq(queue[queue.length - 1]!, next)) {
    return [...queue.slice(0, -1), next];
  }
  return [...queue, next];
}

function advanceTransitionQueue<T>(
  incoming: unknown,
  queue: T[],
  history: readonly T[],
  preBurst: unknown,
  match: (inc: any, exp: T) => boolean,
  sameExp: (a: T, b: T) => boolean,
  coalescedProof: boolean,
): "settled" | "pending" {
  if (queue.length === 0) return "settled";
  const finalTarget = queue[queue.length - 1]!;
  if (coalescedProof && match(incoming, finalTarget)) {
    queue.length = 0;
    return "settled";
  }
  if (match(incoming, queue[0]!)) {
    queue.shift();
    return queue.length === 0 ? "settled" : "pending";
  }
  if (queue.length > 1 && match(incoming, finalTarget)) {
    const appearedEarlier = history.slice(0, -1).some((q) => sameExp(q, finalTarget));
    const matchesPreBurst = preBurst !== undefined && match(incoming, preBurst as any);
    if (!appearedEarlier && !matchesPreBurst) {
      queue.length = 0;
      return "settled";
    }
  }
  return "pending";
}

/** Session options (model/effort/mode/skills/access) + dual-horizon
 * reconciliation with the daemon (live `session_data` stream vs debounced
 * SignalDB mirror pulls). The FRONTEND owns mode derivation and skill
 * validation: the mode sent on create/configure comes from the lowest-priority
 * selected skill, and the daemon stores what it receives (validating only the
 * mode enum). */
export function createSessionOptions(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  /** Effective catalog lookup (official daemon list reconciled with the
   * mode-skill cache): a skill's original mode/usable/approvalMode, if known. */
  getSkill?: (name: string) => { mode?: string; usable?: string; approvalMode?: string } | undefined;
  /** Mode-skill names currently available, in preference order (the
   * effective picker list). Defaults to the 4 cached names. */
  listModeSkills?: () => string[];
  /** The ACTIVE session's locked base mode: a session keeps the mode it
   * was created with, so for existing sessions the wire mode is always
   * this — never re-derived from the (possibly edited) selection.
   * Undefined in draft (creation derives from the primary skill). */
  getLockedMode?: () => "agentic" | "talk" | undefined;
  /** Current SignalDB session row for `sid` (used to snapshot baseline
   * identity before a local edit travels to the daemon). */
  getMirrorSession?: (sid: string) => {
    model?: string;
    options?: any;
    skills?: any;
    approvalMode?: string;
    updatedAt?: number;
  } | null | undefined;
  /** Current SignalDB `configDoc()?.lastSelection` snapshot (used to guard
   * Draft `lastLocalSelection` from clearing against pre-edit config state). */
  getSavedSelection?: () => any;
  /** Optional causal pull clock tracker from the WS transport layer. */
  causalPullClock?: CausalPullClock;
}) {
  const [effort, setEffort] = createSignal("medium");
  const [effortPreviewing, setEffortPreviewing] = createSignal(false);
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

  const recordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  };
  /** Per-skill usable override for the session ("inherit" | "ask" | "yolo" |
   * "deny"); "deny" = AI-hidden but user-activatable, "never" skills are
   * base-only and never appear here. */
  const [skillUsables, setSkillUsables] = createSignal<Record<string, string>>({}, { equals: recordsEqual });

  function lookupSkill(name: string): { mode?: string; usable?: string; approvalMode?: string } | undefined {
    if (opts.getSkill) return opts.getSkill(name);
    const cached = effectiveModeSkills(undefined, false).find((m) => m.name === name);
    return cached ? { mode: cached.mode, usable: cached.usable, approvalMode: cached.approvalMode } : undefined;
  }

  /** The selection with the primary-skill invariant applied: exactly one
   * available mode skill first (when any exists). */
  function ensuredSelection(sel: string[]): string[] {
    return ensureModeSkill(normalizeSkillSelection(sel), opts.listModeSkills?.() ?? MODE_SKILL_NAMES);
  }
  /** Applies the invariant to the live selection state (draft bootstrap:
   * a fresh draft with no mode skill picks the first available one). */
  function ensureSelection() {
    return untrack(() => {
      const current = selectedSkills();
      const next = ensuredSelection(current);
      if (!arraysEqual(current, next)) {
        setSelectedSkills(next);
      }
      const derived = deriveSessionMode(next, (n) => lookupSkill(n)?.mode);
      if (agentMode() !== derived) {
        setAgentMode(derived);
      }
      return next;
    });
  }
  /** The wire usable for one skill: only present when the session value
   * differs from the skill file's original (omitted = inherit). */
  function usableEntry(name: string, value: string | undefined): { usable?: string } {
    return usableDiffers(value, lookupSkill(name)?.usable) ? { usable: value } : {};
  }
  function effectiveSessionUsable(name: string, value: string | undefined): string {
    return usableDiffers(value, lookupSkill(name)?.usable) ? (value as string) : "inherit";
  }
  /** The mode the next create/configure will carry: the locked session
   * mode for an existing session, otherwise derived from the ensured
   * selection's lowest-priority skill. Drives draft UI (project picker
   * visibility) before anything is sent. */
  function pendingMode(): "agentic" | "talk" {
    return opts.getLockedMode?.() ?? deriveSessionMode(ensuredSelection(selectedSkills()), (n) => lookupSkill(n)?.mode);
  }
  function sessionOptions() {
    // The wire carries the mode owned HERE: a session's locked mode once
    // it exists (mode never changes after creation), or the mode derived
    // from the lowest-priority selected skill for a new one. Plus ONLY
    // the active skills in priority order, each with usable only when it
    // differs from the original skill file.
    return untrack(() => {
      const selection = ensuredSelection(selectedSkills());
      const usables = skillUsables();
      return {
        effort: normalizeEffort(effort()) || "medium",
        mode: pendingMode(),
        skills: selection.map((name) => ({ name, ...usableEntry(name, usables[name]) })),
        access: yoloMode() ? "full" : "ask",
      };
    });
  }

  type LocalSelection = ReturnType<typeof sessionOptions> & { model: string };

  function canonicalChoice(c: any): {
    model: string;
    effort: string;
    mode: "agentic" | "talk";
    access: "ask" | "full";
    skills: string[];
    skillUsables: Record<string, string>;
  } {
    const rawMode = String(c?.mode || "").trim().toLowerCase();
    const mode: "agentic" | "talk" = rawMode === "talk" ? "talk" : "agentic";
    const skills: string[] = [];
    const usablesMap: Record<string, string> = {};
    if (Array.isArray(c?.skills)) {
      for (const item of c.skills) {
        if (typeof item === "string" && item) {
          skills.push(item);
        } else if (item && typeof item === "object" && typeof item.name === "string" && item.name) {
          skills.push(item.name);
          if (typeof item.usable === "string" && item.usable && item.usable !== "inherit") {
            usablesMap[item.name] = item.usable;
          }
        }
      }
    }
    return {
      model: String(c?.model || ""),
      effort: normalizeEffort(String(c?.effort || "")) || "medium",
      mode,
      access: c?.access === "ask" ? "ask" : "full",
      skills,
      skillUsables: usablesMap,
    };
  }

  function matchesChoice(incoming: any, expected: any): boolean {
    if (!incoming || !expected) return false;
    const inc = canonicalChoice(incoming);
    const exp = canonicalChoice(expected);
    // When expected.model is "" (catalog not loaded yet when user edited
    // effort/access/mode), accept whichever model the daemon holds.
    const modelOk = exp.model === "" || inc.model === exp.model;
    return modelOk && inc.effort === exp.effort && inc.mode === exp.mode && inc.access === exp.access;
  }

  function sameChoiceTarget(a: LocalSelection, b: LocalSelection): boolean {
    const ca = canonicalChoice(a);
    const cb = canonicalChoice(b);
    return ca.model === cb.model && ca.effort === cb.effort && ca.mode === cb.mode && ca.access === cb.access;
  }

  function matchesDraftChoice(incoming: any, expected: any): boolean {
    if (!matchesChoice(incoming, expected)) return false;
    const inc = canonicalChoice(incoming);
    const exp = canonicalChoice(expected);
    return arraysEqual(inc.skills, exp.skills) && recordsEqual(inc.skillUsables, exp.skillUsables);
  }

  function sameDraftTarget(a: LocalSelection, b: LocalSelection): boolean {
    const ca = canonicalChoice(a);
    const cb = canonicalChoice(b);
    return (
      ca.model === cb.model &&
      ca.effort === cb.effort &&
      ca.mode === cb.mode &&
      ca.access === cb.access &&
      arraysEqual(ca.skills, cb.skills) &&
      recordsEqual(ca.skillUsables, cb.skillUsables)
    );
  }

  // --- Draft remembered-selection tracking ---
  let lastLocalSelection: LocalSelection | undefined;
  let lastLocalSelectionUntil = 0;
  let draftQueue: LocalSelection[] = [];
  let draftHistory: LocalSelection[] = [];
  let lastLocalSelectionBaseline: unknown = undefined;
  let lastLocalSelectionPreBurst: unknown = undefined;
  let lastLocalSelectionRequiredClock = 0;
  let lastObservedSavedSelection: unknown = undefined;
  let lastEvaluatedSavedRef: unknown = undefined;
  let lastEvaluatedSavedClock = false;

  function recordLocalSelection(next: LocalSelection, sentConfigure: boolean) {
    const now = Date.now();
    const currentSaved = opts.getSavedSelection !== undefined ? opts.getSavedSelection() : lastObservedSavedSelection;
    if (!lastLocalSelection) {
      lastLocalSelectionBaseline = currentSaved;
      lastLocalSelectionPreBurst = currentSaved;
    }
    lastLocalSelection = next;
    lastLocalSelectionUntil = now + PENDING_SYNC_TTL_MS;
    draftQueue = pushDistinct(draftQueue, next, sameDraftTarget);
    draftHistory = pushDistinct(draftHistory, next, sameDraftTarget);
    if (sentConfigure && opts.causalPullClock) {
      lastLocalSelectionRequiredClock = opts.causalPullClock.nextClock();
    }
  }

  function clearLastLocalSelection() {
    lastLocalSelection = undefined;
    lastLocalSelectionUntil = 0;
    draftQueue = [];
    draftHistory = [];
    lastLocalSelectionBaseline = undefined;
    lastLocalSelectionPreBurst = undefined;
    lastLocalSelectionRequiredClock = 0;
    lastEvaluatedSavedRef = undefined;
    lastEvaluatedSavedClock = false;
  }

  function getLastLocalSelection() {
    return lastLocalSelection;
  }

  /** Reconciles Draft `lastLocalSelection` with SignalDB's `configDoc()?.lastSelection`.
   * Never clears against the pre-edit cached object before a causal config pull
   * completes, expires cleanly after `PENDING_SYNC_TTL_MS` when a newer remote
   * selection arrives, and compares canonical model + effort + mode + access + skills. */
  function reconcileSavedSelection(saved: any) {
    return untrack(() => {
      lastObservedSavedSelection = saved;
      if (!lastLocalSelection) return saved;
      if (!saved) return lastLocalSelection;
      const now = Date.now();
      const hasClock = Boolean(lastLocalSelectionRequiredClock > 0 && opts.causalPullClock);
      const clockConfirmed = hasClock
        ? opts.causalPullClock!.confirmedClock("config") >= lastLocalSelectionRequiredClock
        : false;
      if (!clockConfirmed && saved === lastLocalSelectionBaseline) {
        return lastLocalSelection;
      }
      if (saved !== lastLocalSelectionBaseline && now >= lastLocalSelectionUntil) {
        clearLastLocalSelection();
        return saved;
      }
      if (hasClock && !clockConfirmed) {
        return lastLocalSelection;
      }
      if (
        lastEvaluatedSavedRef !== undefined &&
        saved === lastEvaluatedSavedRef &&
        (!clockConfirmed || lastEvaluatedSavedClock)
      ) {
        return lastLocalSelection;
      }
      const status = advanceTransitionQueue(
        saved,
        draftQueue,
        draftHistory,
        lastLocalSelectionPreBurst,
        matchesDraftChoice,
        sameDraftTarget,
        clockConfirmed,
      );
      if (status !== "settled") {
        lastEvaluatedSavedRef = saved;
        lastEvaluatedSavedClock = clockConfirmed;
        return lastLocalSelection;
      }
      clearLastLocalSelection();
      return saved;
    });
  }

  // --- Dual-horizon session choice guards (`session_data` vs `mirror.sessions()`) ---
  interface PendingChoiceGuard {
    sessionId: string;
    choice: LocalSelection;
    queue: LocalSelection[];
    history: LocalSelection[];
    preBurst?: unknown;
    preBurstUpdatedAt?: number;
    until: number;
    staleRowRef?: unknown;
    staleOptionsRef?: unknown;
    lastEvaluatedRowRef?: unknown;
    lastEvaluatedOptionsRef?: unknown;
    lastEvaluatedCoalesced?: boolean;
    minUpdatedAt?: number;
    requiredSessionsClock?: number;
    liveSettledClock?: number;
  }
  let pendingLiveChoice: PendingChoiceGuard | undefined;
  let pendingMirrorChoice: PendingChoiceGuard | undefined;
  let lastObservedLiveChoice: { sid: string; choice: unknown; updatedAt?: number } | undefined;
  let lastObservedMirrorChoice: {
    sid: string;
    choice: unknown;
    rowRef?: unknown;
    optionsRef?: unknown;
    updatedAt?: number;
  } | undefined;

  function activeGuard<T extends { sessionId: string; until: number }>(
    guard: T | undefined,
    sid: string,
    now: number,
  ): T | undefined {
    if (!guard) return undefined;
    if (now >= guard.until) return undefined;
    return guard.sessionId === sid ? guard : undefined;
  }

  function configureSession() {
    const nextSelection: LocalSelection = { model: untrack(activeModel), ...sessionOptions() };
    recordLocalSelection(nextSelection, true);
    const sid = untrack(() => opts.getSessionId());
    if (sid) {
      const now = Date.now();
      const until = now + PENDING_SYNC_TTL_MS;
      const curRow = untrack(() => opts.getMirrorSession?.(sid));
      const curMirrorChoice =
        curRow && (curRow.model || curRow.options)
          ? { model: curRow.model || "", ...(curRow.options || {}) }
          : lastObservedMirrorChoice?.sid === sid
            ? lastObservedMirrorChoice.choice
            : undefined;
      const priorLive = activeGuard(pendingLiveChoice, sid, now);
      const priorMirror = activeGuard(pendingMirrorChoice, sid, now);

      const livePreBurst =
        priorLive !== undefined
          ? priorLive.preBurst
          : lastObservedLiveChoice?.sid === sid
            ? lastObservedLiveChoice.choice
            : curMirrorChoice;
      const mirrorPreBurst = priorMirror !== undefined ? priorMirror.preBurst : curMirrorChoice;
      const mirrorPreBurstUpdatedAt =
        priorMirror !== undefined
          ? priorMirror.preBurstUpdatedAt
          : curRow?.updatedAt ?? (lastObservedMirrorChoice?.sid === sid ? lastObservedMirrorChoice.updatedAt : undefined);

      const staleRowRef =
        priorMirror?.staleRowRef !== undefined
          ? priorMirror.staleRowRef
          : curRow !== undefined
            ? curRow
            : lastObservedMirrorChoice?.sid === sid
              ? lastObservedMirrorChoice.rowRef
              : undefined;
      const staleOptionsRef =
        priorMirror?.staleOptionsRef !== undefined
          ? priorMirror.staleOptionsRef
          : curRow !== undefined
            ? curRow?.options
            : lastObservedMirrorChoice?.sid === sid
              ? lastObservedMirrorChoice.optionsRef
              : undefined;

      pendingLiveChoice = {
        sessionId: sid,
        choice: nextSelection,
        queue: pushDistinct(priorLive ? priorLive.queue : [], nextSelection, sameChoiceTarget),
        history: pushDistinct(priorLive ? priorLive.history : [], nextSelection, sameChoiceTarget),
        preBurst: livePreBurst,
        until,
      };
      pendingMirrorChoice = {
        sessionId: sid,
        choice: nextSelection,
        queue: pushDistinct(priorMirror ? priorMirror.queue : [], nextSelection, sameChoiceTarget),
        history: pushDistinct(priorMirror ? priorMirror.history : [], nextSelection, sameChoiceTarget),
        preBurst: mirrorPreBurst,
        preBurstUpdatedAt: mirrorPreBurstUpdatedAt,
        until,
        staleRowRef,
        staleOptionsRef,
        lastEvaluatedRowRef: priorMirror?.lastEvaluatedRowRef,
        lastEvaluatedOptionsRef: priorMirror?.lastEvaluatedOptionsRef,
        lastEvaluatedCoalesced: priorMirror?.lastEvaluatedCoalesced,
        minUpdatedAt: undefined,
        requiredSessionsClock: opts.causalPullClock ? opts.causalPullClock.nextClock() : undefined,
        liveSettledClock: undefined,
      };
    } else {
      pendingLiveChoice = undefined;
      pendingMirrorChoice = undefined;
    }
    opts.send({
      type: "configure_session",
      sessionId: sid || "",
      model: nextSelection.model,
      options: {
        effort: nextSelection.effort,
        mode: nextSelection.mode,
        skills: nextSelection.skills,
        access: nextSelection.access,
      },
    });
  }

  function applyOptions(options: any) {
    untrack(() => {
      if (!effortPreviewing()) {
        setEffort(normalizeEffort(String(options?.effort || "")) || "medium");
      }
      const mode = String(options?.mode || "").toLowerCase();
      setAgentMode(mode === "talk" ? "talk" : "agentic");
      // The live skill selection is NOT taken from options.skills (the daemon
      // echoes it empty): it arrives as the session skill map snapshot via
      // applySessionSkills.
      setYoloMode(options?.access !== "ask");
    });
  }

  /** Applies the daemon's resolved approval mode (session snapshot).
   * Only forces `yoloMode` true when primary skill locks `mode === "yolo"`;
   * never alters `yoloMode` when `mode === "ask"`. */
  function applyApprovalMode(mode: string | undefined) {
    untrack(() => {
      const next = mode === "yolo" ? "yolo" : "ask";
      setApprovalMode(next);
      if (next === "yolo") setYoloMode(true);
    });
  }

  function applyModelWithCatalog(model: string | undefined, knownModelIds: string[], fallbackModelId: string) {
    if (!model) return;
    if (knownModelIds.length === 0 && !fallbackModelId) {
      setActiveModel(model);
      return;
    }
    setActiveModel(knownModelIds.some((m) => m === model) ? model : fallbackModelId);
  }

  /** Reconciles live stream selection (`session_data`). Clears `pendingLiveChoice`
   * when caught up while leaving `pendingMirrorChoice` armed until SignalDB's
   * debounced pull also catches up. */
  function reconcileLiveSelection(
    sid: string,
    model: string | undefined,
    options: any,
    knownModelIds: string[],
    fallbackModelId: string,
    updatedAt?: number,
  ): boolean {
    return untrack(() => {
      const now = Date.now();
      const incoming = { model, ...(options || {}) };
      if (pendingLiveChoice && now >= pendingLiveChoice.until) pendingLiveChoice = undefined;
      const pending = activeGuard(pendingLiveChoice, sid, now);
      if (pending) {
        const status = advanceTransitionQueue(
          incoming,
          pending.queue,
          pending.history,
          pending.preBurst,
          matchesChoice,
          sameChoiceTarget,
          false,
        );
        if (status !== "settled") {
          return false;
        }
        pendingLiveChoice = undefined;
        const mirrorGuard = activeGuard(pendingMirrorChoice, sid, now);
        if (mirrorGuard) {
          if (typeof updatedAt === "number" && updatedAt > 0) {
            mirrorGuard.minUpdatedAt = Math.max(mirrorGuard.minUpdatedAt ?? 0, updatedAt);
          }
          if (opts.causalPullClock) {
            mirrorGuard.liveSettledClock = opts.causalPullClock.nextClock();
          }
        }
      }
      lastObservedLiveChoice = { sid, choice: canonicalChoice(incoming), updatedAt };
      applyModelWithCatalog(model, knownModelIds, fallbackModelId);
      applyOptions(options);
      if (approvalMode() === "yolo") setYoloMode(true);
      return true;
    });
  }

  /** Reconciles delayed SignalDB mirror row (`activeSession()`). Blocks reverts
   * while `pendingMirrorChoice` is active until the mirror row itself catches up. */
  function reconcileMirrorSelection(
    sid: string,
    model: string | undefined,
    options: any,
    knownModelIds: string[],
    fallbackModelId: string,
    mirrorMeta?: MirrorSyncMeta,
  ): boolean {
    return untrack(() => {
      const now = Date.now();
      const rowRef = mirrorMeta?.rowRef;
      const updatedAt = mirrorMeta?.updatedAt;
      const incoming = { model, ...(options || {}) };

      if (pendingLiveChoice && now >= pendingLiveChoice.until) pendingLiveChoice = undefined;
      if (pendingMirrorChoice && now >= pendingMirrorChoice.until) pendingMirrorChoice = undefined;

      const livePending = activeGuard(pendingLiveChoice, sid, now);
      const mirrorPending = activeGuard(pendingMirrorChoice, sid, now);

      if (mirrorPending) {
        if (
          (mirrorPending.staleRowRef !== undefined && rowRef !== undefined && rowRef === mirrorPending.staleRowRef) ||
          (mirrorPending.staleOptionsRef !== undefined && options !== undefined && options === mirrorPending.staleOptionsRef)
        ) {
          return false;
        }
        if (
          typeof mirrorPending.requiredSessionsClock === "number" &&
          opts.causalPullClock &&
          opts.causalPullClock.confirmedClock("sessions") < mirrorPending.requiredSessionsClock
        ) {
          return false;
        }
        const clockConfirmedAfterLive = Boolean(
          !livePending &&
            typeof mirrorPending.liveSettledClock === "number" &&
            opts.causalPullClock &&
            opts.causalPullClock.confirmedClock("sessions") >= mirrorPending.liveSettledClock,
        );
        const timestampConfirmedAfterLive = Boolean(
          !livePending &&
            typeof mirrorPending.minUpdatedAt === "number" &&
            typeof updatedAt === "number" &&
            updatedAt >= mirrorPending.minUpdatedAt &&
            (mirrorPending.preBurstUpdatedAt === undefined || updatedAt > mirrorPending.preBurstUpdatedAt),
        );
        const coalesced = clockConfirmedAfterLive || timestampConfirmedAfterLive;
        if (!coalesced || mirrorPending.lastEvaluatedCoalesced === true) {
          if (
            (mirrorPending.lastEvaluatedRowRef !== undefined &&
              rowRef !== undefined &&
              rowRef === mirrorPending.lastEvaluatedRowRef) ||
            (rowRef === undefined &&
              mirrorPending.lastEvaluatedOptionsRef !== undefined &&
              options !== undefined &&
              options === mirrorPending.lastEvaluatedOptionsRef)
          ) {
            return false;
          }
        }
        const status = advanceTransitionQueue(
          incoming,
          mirrorPending.queue,
          mirrorPending.history,
          mirrorPending.preBurst,
          matchesChoice,
          sameChoiceTarget,
          coalesced,
        );
        if (status !== "settled") {
          mirrorPending.lastEvaluatedRowRef = rowRef;
          mirrorPending.lastEvaluatedOptionsRef = options;
          mirrorPending.lastEvaluatedCoalesced = coalesced;
          return false;
        }
        if (
          typeof mirrorPending.minUpdatedAt === "number" &&
          typeof updatedAt === "number" &&
          updatedAt > 0 &&
          updatedAt < mirrorPending.minUpdatedAt
        ) {
          // A pre-final row matched the target signature prematurely: keep
          // armed for the final row whose updatedAt >= minUpdatedAt.
          mirrorPending.queue = [mirrorPending.choice];
          mirrorPending.lastEvaluatedRowRef = rowRef;
          mirrorPending.lastEvaluatedOptionsRef = options;
          mirrorPending.lastEvaluatedCoalesced = coalesced;
          return false;
        }
        pendingMirrorChoice = undefined;
      }

      lastObservedMirrorChoice = {
        sid,
        choice: canonicalChoice(incoming),
        rowRef,
        optionsRef: options,
        updatedAt,
      };
      applyModelWithCatalog(model, knownModelIds, fallbackModelId);
      applyOptions(options);
      if (approvalMode() === "yolo") setYoloMode(true);
      return true;
    });
  }

  // --- Dual-horizon session skill + approvalMode guards ---
  /** True once the current draft's skill selection is settled (seeded from
   * the remembered choice, or edited by the user): later config refreshes
   * must not reseed it. Reset when a session snapshot takes over. */
  let draftSeeded = false;

  type RawSkillMap = Record<string, { priority?: number; active?: boolean; usable?: string }> | undefined;

  interface SkillsTarget {
    skills: string[];
    usables: Record<string, string>;
  }

  interface PendingSkillsGuard {
    sessionId: string;
    target: SkillsTarget;
    queue: SkillsTarget[];
    history: SkillsTarget[];
    preBurst?: RawSkillMap;
    preBurstUpdatedAt?: number;
    until: number;
    staleRowRef?: unknown;
    staleSkillsRef?: unknown;
    lastEvaluatedRowRef?: unknown;
    lastEvaluatedSkillsRef?: RawSkillMap;
    lastEvaluatedCoalesced?: boolean;
    minUpdatedAt?: number;
    requiredSessionsClock?: number;
    liveSettledClock?: number;
  }
  let pendingLiveSkills: PendingSkillsGuard | undefined;
  let pendingMirrorSkills: PendingSkillsGuard | undefined;
  let lastObservedLiveSkills: { sid: string; skills: RawSkillMap; updatedAt?: number } | undefined;
  let lastObservedMirrorSkills: { sid: string; rowRef?: unknown; skillsRef?: RawSkillMap; updatedAt?: number } | undefined;

  function parseSessionSkills(skills: RawSkillMap) {
    const map: Record<string, string> = {};
    const active: { name: string; priority: number }[] = [];
    for (const [name, st] of Object.entries(skills || {})) {
      if (!st || typeof st !== "object") continue;
      map[name] = st.usable || "inherit";
      if (st.active) active.push({ name, priority: st.priority ?? 0 });
    }
    // Same tie-break as the daemon's Resolve (byte order of the name), so
    // the primary skill shown here is the one the daemon resolves.
    active.sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      map,
      selected: ensuredSelection(active.map((s) => s.name)),
    };
  }

  function skillsMatchTarget(skills: RawSkillMap, target: SkillsTarget): boolean {
    if (!skills || typeof skills !== "object") return false;
    const parsed = parseSessionSkills(skills);
    if (!arraysEqual(parsed.selected, target.skills)) return false;
    for (const [name, expectedUsable] of Object.entries(target.usables)) {
      if ((parsed.map[name] || "inherit") !== expectedUsable) return false;
    }
    return true;
  }

  function sameSkillsTarget(a: SkillsTarget, b: SkillsTarget): boolean {
    return arraysEqual(a.skills, b.skills) && recordsEqual(a.usables, b.usables);
  }

  /** Unconditional skill map replacement (used on explicit session load /
   * creation / fork after `resetPending()`). */
  function applySessionSkills(skills: RawSkillMap) {
    untrack(() => {
      const parsed = parseSessionSkills(skills);
      setSkillUsables(parsed.map);
      setSelectedSkills(parsed.selected);
      draftSeeded = false;
      pendingLiveSkills = undefined;
      pendingMirrorSkills = undefined;
      const sid = opts.getSessionId();
      if (sid) {
        lastObservedLiveSkills = { sid, skills };
        lastObservedMirrorSkills = { sid, skillsRef: skills };
      }
    });
  }

  /** Live `session_data` variant of `applySessionSkills`: ignores stale skill
   * maps (e.g. a `configure_session` ack carrying pre-`update_skills` skills)
   * while `pendingLiveSkills` is active, and keeps `pendingMirrorSkills` armed
   * once caught up. */
  function applyLiveSessionSkills(
    sessionId: string,
    skills: RawSkillMap,
    incomingApprovalMode?: string,
    updatedAt?: number,
  ): boolean {
    return untrack(() => {
      const now = Date.now();
      if (pendingLiveSkills && now >= pendingLiveSkills.until) pendingLiveSkills = undefined;
      const pending = activeGuard(pendingLiveSkills, sessionId, now);
      if (pending) {
        const status = advanceTransitionQueue(
          skills,
          pending.queue,
          pending.history,
          pending.preBurst,
          skillsMatchTarget,
          sameSkillsTarget,
          false,
        );
        if (status !== "settled") {
          return false;
        }
        pendingLiveSkills = undefined;
        const mirrorGuard = activeGuard(pendingMirrorSkills, sessionId, now);
        if (mirrorGuard) {
          if (typeof updatedAt === "number" && updatedAt > 0) {
            mirrorGuard.minUpdatedAt = Math.max(mirrorGuard.minUpdatedAt ?? 0, updatedAt);
          }
          if (opts.causalPullClock) {
            mirrorGuard.liveSettledClock = opts.causalPullClock.nextClock();
          }
        }
      }
      lastObservedLiveSkills = { sid: sessionId, skills, updatedAt };
      const parsed = parseSessionSkills(skills);
      setSkillUsables(parsed.map);
      setSelectedSkills(parsed.selected);
      draftSeeded = false;
      if (incomingApprovalMode !== undefined) {
        applyApprovalMode(incomingApprovalMode);
      }
      return true;
    });
  }

  /** Delayed SignalDB mirror variant of `applySessionSkills`: keeps
   * `pendingMirrorSkills` armed until the mirror's own `s.skills` catches up. */
  function applyMirrorSessionSkills(
    sessionId: string,
    skills: RawSkillMap,
    incomingApprovalMode?: string,
    mirrorMeta?: MirrorSyncMeta,
  ): boolean {
    return untrack(() => {
      const now = Date.now();
      const rowRef = mirrorMeta?.rowRef;
      const updatedAt = mirrorMeta?.updatedAt;

      if (pendingLiveSkills && now >= pendingLiveSkills.until) pendingLiveSkills = undefined;
      if (pendingMirrorSkills && now >= pendingMirrorSkills.until) pendingMirrorSkills = undefined;

      const livePending = activeGuard(pendingLiveSkills, sessionId, now);
      const mirrorPending = activeGuard(pendingMirrorSkills, sessionId, now);

      if (mirrorPending) {
        if (
          (mirrorPending.staleRowRef !== undefined && rowRef !== undefined && rowRef === mirrorPending.staleRowRef) ||
          (mirrorPending.staleSkillsRef !== undefined && skills !== undefined && skills === mirrorPending.staleSkillsRef)
        ) {
          return false;
        }
        if (
          typeof mirrorPending.requiredSessionsClock === "number" &&
          opts.causalPullClock &&
          opts.causalPullClock.confirmedClock("sessions") < mirrorPending.requiredSessionsClock
        ) {
          return false;
        }
        const clockConfirmedAfterLive = Boolean(
          !livePending &&
            typeof mirrorPending.liveSettledClock === "number" &&
            opts.causalPullClock &&
            opts.causalPullClock.confirmedClock("sessions") >= mirrorPending.liveSettledClock,
        );
        const timestampConfirmedAfterLive = Boolean(
          !livePending &&
            typeof mirrorPending.minUpdatedAt === "number" &&
            typeof updatedAt === "number" &&
            updatedAt >= mirrorPending.minUpdatedAt &&
            (mirrorPending.preBurstUpdatedAt === undefined || updatedAt > mirrorPending.preBurstUpdatedAt),
        );
        const coalesced = clockConfirmedAfterLive || timestampConfirmedAfterLive;
        if (!coalesced || mirrorPending.lastEvaluatedCoalesced === true) {
          if (
            (mirrorPending.lastEvaluatedRowRef !== undefined &&
              rowRef !== undefined &&
              rowRef === mirrorPending.lastEvaluatedRowRef) ||
            (rowRef === undefined &&
              mirrorPending.lastEvaluatedSkillsRef !== undefined &&
              skills !== undefined &&
              skills === mirrorPending.lastEvaluatedSkillsRef)
          ) {
            return false;
          }
        }
        const status = advanceTransitionQueue(
          skills,
          mirrorPending.queue,
          mirrorPending.history,
          mirrorPending.preBurst,
          skillsMatchTarget,
          sameSkillsTarget,
          coalesced,
        );
        if (status !== "settled") {
          mirrorPending.lastEvaluatedRowRef = rowRef;
          mirrorPending.lastEvaluatedSkillsRef = skills;
          mirrorPending.lastEvaluatedCoalesced = coalesced;
          return false;
        }
        if (
          typeof mirrorPending.minUpdatedAt === "number" &&
          typeof updatedAt === "number" &&
          updatedAt > 0 &&
          updatedAt < mirrorPending.minUpdatedAt
        ) {
          mirrorPending.queue = [mirrorPending.target];
          mirrorPending.lastEvaluatedRowRef = rowRef;
          mirrorPending.lastEvaluatedSkillsRef = skills;
          mirrorPending.lastEvaluatedCoalesced = coalesced;
          return false;
        }
        pendingMirrorSkills = undefined;
      }

      lastObservedMirrorSkills = { sid: sessionId, rowRef, skillsRef: skills, updatedAt };
      const parsed = parseSessionSkills(skills);
      setSkillUsables(parsed.map);
      setSelectedSkills(parsed.selected);
      draftSeeded = false;
      if (incomingApprovalMode !== undefined) {
        applyApprovalMode(incomingApprovalMode);
      }
      return true;
    });
  }

  /** Starts a draft from a clean slate: the previous session's selection,
   * usable overrides and approval mode never carry over. The primary skill
   * comes from the remembered choice (its mode skill, or one matching its
   * mode); additional skills are per conversation and start empty. With
   * `force` false this only seeds a draft nobody settled yet (config
   * refreshes must not undo an in-draft pick). */
  function resetDraftSkills(remembered?: { mode?: string; skills?: ({ name: string } | string)[] } | null, force = true) {
    untrack(() => {
      if (!force && draftSeeded) {
        ensureSelection();
        return;
      }
      const available = opts.listModeSkills?.() ?? MODE_SKILL_NAMES;
      const rememberedNames = (remembered?.skills ?? [])
        .map((s) => (typeof s === "string" ? s : s?.name))
        .filter(Boolean) as string[];
      const primary =
        rememberedNames.find((n) => isModeSkillName(n) && available.includes(n)) ??
        (remembered?.mode
          ? available.find((n) => baseMode(lookupSkill(n)?.mode) === baseMode(remembered.mode))
          : undefined);
      setSkillUsables({});
      setSelectedSkills(primary ? [primary] : []);
      const settled = ensureSelection();
      const effectivePrimary = settled[0];
      const primaryAp = effectivePrimary ? lookupSkill(effectivePrimary)?.approvalMode : undefined;
      applyApprovalMode(primaryAp);
      draftSeeded = !!primary;
    });
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
    untrack(() => {
      const skills = ensuredSelection(next);
      const prev = selectedSkills();
      const prevUsables = skillUsables();
      const targetUsables = usables ?? prevUsables;
      const prevSet = new Set(prev);
      const nextSet = new Set(skills);
      const set: Record<string, { active: boolean; usable?: string }> = {};
      for (const name of skills) {
        if (!prevSet.has(name)) {
          set[name] = { active: true, ...usableEntry(name, targetUsables[name]) };
        }
      }
      const unset: string[] = [];
      for (const name of prev) {
        // Deactivation is a set{active:false} (a differing usable override
        // still rides along so it survives); `unset` stays reserved for
        // true removal from the session map.
        if (!nextSet.has(name)) set[name] = { active: false, ...usableEntry(name, targetUsables[name]) };
      }
      // Ensure mutual exclusion between base modes (build, plan, learning,
      // talk): a mode skill the session map still knows (it has an entry,
      // active or not, in the last snapshot) and that is not the chosen one
      // is explicitly deactivated. Mode skills the session never had need no
      // entry — sending {active:false} for them only bloats the map.
      const modeSkillsList = opts.listModeSkills?.() ?? MODE_SKILL_NAMES;
      for (const m of modeSkillsList) {
        if (!nextSet.has(m) && !set[m] && m in prevUsables) {
          set[m] = { active: false, ...usableEntry(m, targetUsables[m]) };
        }
      }
      if (usables) {
        for (const [name, usable] of Object.entries(usables)) {
          // "inherit" and unset are the same session value (no override).
          if ((prevUsables[name] || "inherit") !== (usable || "inherit") && !set[name]) {
            set[name] = { active: nextSet.has(name), ...usableEntry(name, usable) };
          }
        }
      }
      const sid = opts.getSessionId();
      batch(() => {
        setSelectedSkills(skills);
        if (usables) setSkillUsables(usables);
        const nextMode = pendingMode();
        if (agentMode() !== nextMode) setAgentMode(nextMode);
        if (!sid || skills[0] !== prev[0]) {
          const primary = skills[0];
          const knownSkill = primary ? lookupSkill(primary) : undefined;
          if (!sid || knownSkill) {
            applyApprovalMode(knownSkill?.approvalMode);
          }
        }
      });

      if (sid) {
        const expectedUsables: Record<string, string> = {};
        for (const name of new Set([...skills, ...Object.keys(set)])) {
          expectedUsables[name] = effectiveSessionUsable(name, targetUsables[name]);
        }
        const target: SkillsTarget = { skills, usables: expectedUsables };
        const now = Date.now();
        const until = now + PENDING_SYNC_TTL_MS;
        const curRow = opts.getMirrorSession?.(sid);
        const curMirrorSkills =
          curRow?.skills !== undefined
            ? curRow.skills
            : lastObservedMirrorSkills?.sid === sid
              ? lastObservedMirrorSkills.skillsRef
              : undefined;
        const priorLive = activeGuard(pendingLiveSkills, sid, now);
        const priorMirror = activeGuard(pendingMirrorSkills, sid, now);

        const livePreBurst =
          priorLive !== undefined
            ? priorLive.preBurst
            : lastObservedLiveSkills?.sid === sid
              ? lastObservedLiveSkills.skills
              : curMirrorSkills;
        const mirrorPreBurst = priorMirror !== undefined ? priorMirror.preBurst : curMirrorSkills;
        const mirrorPreBurstUpdatedAt =
          priorMirror !== undefined
            ? priorMirror.preBurstUpdatedAt
            : curRow?.updatedAt ?? (lastObservedMirrorSkills?.sid === sid ? lastObservedMirrorSkills.updatedAt : undefined);

        const staleRowRef =
          priorMirror?.staleRowRef !== undefined
            ? priorMirror.staleRowRef
            : curRow !== undefined
              ? curRow
              : lastObservedMirrorSkills?.sid === sid
                ? lastObservedMirrorSkills.rowRef
                : undefined;
        const staleSkillsRef =
          priorMirror?.staleSkillsRef !== undefined
            ? priorMirror.staleSkillsRef
            : curRow !== undefined
              ? curRow?.skills
              : lastObservedMirrorSkills?.sid === sid
                ? lastObservedMirrorSkills.skillsRef
                : undefined;

        pendingLiveSkills = {
          sessionId: sid,
          target,
          queue: pushDistinct(priorLive ? priorLive.queue : [], target, sameSkillsTarget),
          history: pushDistinct(priorLive ? priorLive.history : [], target, sameSkillsTarget),
          preBurst: livePreBurst,
          until,
        };
        pendingMirrorSkills = {
          sessionId: sid,
          target,
          queue: pushDistinct(priorMirror ? priorMirror.queue : [], target, sameSkillsTarget),
          history: pushDistinct(priorMirror ? priorMirror.history : [], target, sameSkillsTarget),
          preBurst: mirrorPreBurst,
          preBurstUpdatedAt: mirrorPreBurstUpdatedAt,
          until,
          staleRowRef,
          staleSkillsRef,
          lastEvaluatedRowRef: priorMirror?.lastEvaluatedRowRef,
          lastEvaluatedSkillsRef: priorMirror?.lastEvaluatedSkillsRef,
          lastEvaluatedCoalesced: priorMirror?.lastEvaluatedCoalesced,
          minUpdatedAt: undefined,
          requiredSessionsClock: opts.causalPullClock ? opts.causalPullClock.nextClock() : undefined,
          liveSettledClock: undefined,
        };
        opts.send({ type: "update_skills", sessionId: sid, set, unset, order: skills });
      } else {
        draftSeeded = true; // an in-draft pick is the user's: keep it
        recordLocalSelection({ model: activeModel(), ...sessionOptions() }, false);
      }
    });
  }

  /** Clears every per-session skill state (host switch: nothing from the
   * previous daemon may bleed through until a session or draft takes over). */
  function resetSkillState() {
    untrack(() => {
      setSkillUsables({});
      setApprovalMode("ask");
      setSelectedSkills([]);
      draftSeeded = false;
    });
  }

  /** Alias kept for existing callers: reconciles live `session_data` choices. */
  const reconcileServerSelection = reconcileLiveSelection;

  /** Session/host switch: forgets pending local choices and preview flags. */
  function resetPending() {
    clearLastLocalSelection();
    resetPendingChoice();
    setEffortPreviewing(false);
    lastObservedLiveChoice = undefined;
    lastObservedMirrorChoice = undefined;
    lastObservedLiveSkills = undefined;
    lastObservedMirrorSkills = undefined;
  }
  /** Closed socket / draft transition: forgets only the in-flight session acks
   * while keeping `lastLocalSelection` alive for draft seeding. */
  function resetPendingChoice() {
    pendingLiveChoice = undefined;
    pendingMirrorChoice = undefined;
    pendingLiveSkills = undefined;
    pendingMirrorSkills = undefined;
  }

  return {
    effort,
    setEffort,
    effortPreviewing,
    setEffortPreviewing,
    agentMode,
    setAgentMode,
    selectedSkills,
    setSelectedSkills,
    approvalMode,
    applyApprovalMode,
    syncSkills,
    ensureSelection,
    pendingMode,
    skillUsables,
    applySessionSkills,
    applyLiveSessionSkills,
    applyMirrorSessionSkills,
    resetDraftSkills,
    resetSkillState,
    activeModel,
    setActiveModel,
    yoloMode,
    setYoloMode,
    modeMenuOpen,
    setModeMenuOpen,
    accessMenuOpen,
    setAccessMenuOpen,
    modeBtn,
    accessBtn,
    sessionOptions,
    matchesChoice,
    matchesDraftChoice,
    reconcileSavedSelection,
    configureSession,
    applyOptions,
    reconcileLiveSelection,
    reconcileMirrorSelection,
    reconcileServerSelection,
    resetPending,
    resetPendingChoice,
    getLastLocalSelection,
    clearLastLocalSelection,
  };
}

export type SessionOptions = ReturnType<typeof createSessionOptions>;
