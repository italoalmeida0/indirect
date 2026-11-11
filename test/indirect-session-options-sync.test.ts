import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { createSessionOptions } from "../web/src/indirect-code/hooks/useSessionOptions";
import { createTranscript } from "../web/src/indirect-code/hooks/useTranscript";
import { createTurnChanges } from "../web/src/indirect-code/hooks/useTurnChanges";
import { normalizeSessionMessages } from "../web/src/indirect-code/transcript/updaters";
import { effectiveModeSkills } from "../web/src/indirect-code/utils/modeSkills";

function installMinimalDocument() {
  const prevDocument = (globalThis as any).document;
  const prevRaf = (globalThis as any).requestAnimationFrame;
  const prevCaf = (globalThis as any).cancelAnimationFrame;
  const prevWorker = (globalThis as any).Worker;
  let workerPosts = 0;
  if (!(globalThis as any).document) {
    (globalThis as any).document = {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  if (!(globalThis as any).requestAnimationFrame) {
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number;
  }
  if (!(globalThis as any).cancelAnimationFrame) {
    (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
  (globalThis as any).Worker = class MockHistoryWorker {
    onmessage: ((ev: any) => void) | null = null;
    onerror: ((ev: any) => void) | null = null;
    postMessage(data: { seq: number; rawMsgs: any[]; indexBase: number }) {
      workerPosts++;
      setTimeout(() => {
        const page = normalizeSessionMessages(data.rawMsgs, [], data.indexBase);
        this.onmessage?.({ data: { seq: data.seq, page } });
      }, 4);
    }
    terminate() {}
  };
  const restore = () => {
    if (prevDocument === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDocument;
    if (prevRaf === undefined) delete (globalThis as any).requestAnimationFrame;
    else (globalThis as any).requestAnimationFrame = prevRaf;
    if (prevCaf === undefined) delete (globalThis as any).cancelAnimationFrame;
    else (globalThis as any).cancelAnimationFrame = prevCaf;
    if (prevWorker === undefined) delete (globalThis as any).Worker;
    else (globalThis as any).Worker = prevWorker;
  };
  return { getWorkerPosts: () => workerPosts, restore };
}

function createHarness(initialSid = "s1") {
  let sid = initialSid;
  let clock = 0;
  const confirmed = { sessions: 0, config: 0 };
  let mirrorRow: any = undefined;
  let savedSelection: any = undefined;
  const sent: any[] = [];
  const catalog: Record<string, { mode?: string; usable?: string; approvalMode?: string }> = {
    build: { mode: "agentic", usable: "deny", approvalMode: "ask" },
    plan: { mode: "agentic", usable: "deny", approvalMode: "ask" },
    learning: { mode: "agentic", usable: "deny", approvalMode: "ask" },
    talk: { mode: "talk", usable: "deny", approvalMode: "yolo" },
    review: { mode: "agentic", usable: "ask", approvalMode: "ask" },
    lint: { mode: "agentic", usable: "yolo", approvalMode: "ask" },
  };

  let disposeRoot = () => {};
  const options = createRoot((dispose) => {
    disposeRoot = dispose;
    return createSessionOptions({
      send: (cmd) => sent.push(cmd),
      getSessionId: () => sid,
      getSkill: (name) => {
        if (catalog[name]) return catalog[name];
        const cached = effectiveModeSkills(undefined, false).find((m) => m.name === name);
        return cached ? { mode: cached.mode, usable: cached.usable, approvalMode: cached.approvalMode } : undefined;
      },
      listModeSkills: () => (sid ? ["build", "plan", "learning"] : ["build", "plan", "talk", "learning"]),
      getLockedMode: () => (sid ? "agentic" : undefined),
      getMirrorSession: (id) => (mirrorRow?.id === id ? mirrorRow : undefined),
      getSavedSelection: () => savedSelection,
      causalPullClock: {
        nextClock: () => ++clock,
        confirmedClock: (col) => confirmed[col],
      },
    });
  });

  return {
    options,
    sent,
    catalog,
    dispose: () => disposeRoot(),
    setSid: (next: string) => {
      sid = next;
    },
    getClock: () => clock,
    confirmPull: (col: "sessions" | "config", pullStartClock: number) => {
      confirmed[col] = Math.max(confirmed[col], pullStartClock);
    },
    setMirrorRow: (row: any) => {
      mirrorRow = row;
    },
    getMirrorRow: () => mirrorRow,
    setSavedSelection: (sel: any) => {
      savedSelection = sel;
    },
  };
}

describe("Dual-horizon composer option & skill synchronization", () => {
  test("eliminates New -> Old -> New revert when session_data arrives before debounced SignalDB mirror pull", () => {
    const h = createHarness("s1");
    try {
      const models = ["claude-sonnet", "gpt-5"];
      const initialRow = {
        id: "s1",
        model: "claude-sonnet",
        updatedAt: 100,
        options: { effort: "medium", mode: "agentic", skills: [], access: "full" },
        skills: { build: { priority: 1, active: true, usable: "" } },
        approvalMode: "ask",
      };
      h.setMirrorRow(initialRow);
      h.options.setActiveModel(initialRow.model);
      h.options.applyOptions(initialRow.options);
      h.options.applySessionSkills(initialRow.skills);

      // User changes Model -> gpt-5, Effort -> high, Permissions -> Ask
      h.options.setActiveModel("gpt-5");
      h.options.setEffort("high");
      h.options.setYoloMode(false);
      h.options.configureSession();

      // t=40ms: Daemon immediately broadcasts session_data with the new choice
      const appliedLive = h.options.reconcileLiveSelection(
        "s1",
        "gpt-5",
        { effort: "high", mode: "agentic", skills: [], access: "ask" },
        models,
        models[0]!,
        200,
      );
      expect(appliedLive).toBe(true);
      expect(h.options.activeModel()).toBe("gpt-5");
      expect(h.options.effort()).toBe("high");
      expect(h.options.yoloMode()).toBe(false);

      // t=120ms: Stale SignalDB mirror row (or an in-flight pre-edit pull) evaluates!
      const appliedStaleCached = h.options.reconcileMirrorSelection(
        "s1",
        initialRow.model,
        initialRow.options,
        models,
        models[0]!,
        { rowRef: initialRow, updatedAt: initialRow.updatedAt },
      );
      expect(appliedStaleCached).toBe(false);
      const staleFreshObj = {
        ...initialRow,
        options: { ...initialRow.options },
      };
      const appliedStalePull = h.options.reconcileMirrorSelection(
        "s1",
        staleFreshObj.model,
        staleFreshObj.options,
        models,
        models[0]!,
        { rowRef: staleFreshObj, updatedAt: 100 },
      );
      expect(appliedStalePull).toBe(false);

      // UI MUST remain at New values with zero backward revert
      expect(h.options.activeModel()).toBe("gpt-5");
      expect(h.options.effort()).toBe("high");
      expect(h.options.yoloMode()).toBe(false);

      // t=400ms: Debounced pull initiated after the edit completes
      const pullStart = h.getClock();
      h.confirmPull("sessions", pullStart);
      const freshRow = {
        id: "s1",
        model: "gpt-5",
        updatedAt: 200,
        options: { effort: "high", mode: "agentic", skills: [], access: "ask" },
      };
      h.setMirrorRow(freshRow);
      const appliedFresh = h.options.reconcileMirrorSelection(
        "s1",
        freshRow.model,
        freshRow.options,
        models,
        models[0]!,
        { rowRef: freshRow, updatedAt: freshRow.updatedAt },
      );
      expect(appliedFresh).toBe(true);
      expect(h.options.activeModel()).toBe("gpt-5");
      expect(h.options.effort()).toBe("high");
      expect(h.options.yoloMode()).toBe(false);
    } finally {
      h.dispose();
    }
  });

  test("handles rapid A -> B -> A and 3-click Ask -> Full -> Ask bursts without flicker across interleaved streams", () => {
    const h = createHarness("s1");
    try {
      const models = ["m1"];
      // Start at Full
      const row0 = {
        id: "s1",
        model: "m1",
        updatedAt: 100,
        options: { effort: "medium", mode: "agentic", skills: [], access: "full" },
      };
      h.setMirrorRow(row0);
      h.options.reconcileMirrorSelection("s1", row0.model, row0.options, models, "m1", {
        rowRef: row0,
        updatedAt: 100,
      });
      expect(h.options.yoloMode()).toBe(true);

      // Rapid 3-click burst: Ask (#1) -> Full (#2) -> Ask (#3)
      h.options.setYoloMode(false);
      h.options.configureSession();
      const clockAfterClick1 = h.getClock();

      h.options.setYoloMode(true);
      h.options.configureSession();
      const clockAfterClick2 = h.getClock();

      h.options.setYoloMode(false);
      h.options.configureSession();
      const clockAfterClick3 = h.getClock();

      expect(h.options.yoloMode()).toBe(false);

      // Interleaved acks:
      // 1) session_data #1 (Ask) arrives — must NOT disarm pendingLiveChoice early!
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, models, "m1", 110),
      ).toBe(false);
      expect(h.options.yoloMode()).toBe(false);

      // 2) pull #1 (Ask, initiated after click 1) arrives — must NOT disarm pendingMirrorChoice!
      h.confirmPull("sessions", clockAfterClick1);
      expect(
        h.options.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "ask" },
          models,
          "m1",
          { rowRef: { id: "s1" }, updatedAt: 110 },
        ),
      ).toBe(false);
      expect(h.options.yoloMode()).toBe(false);

      // 3) session_data #2 (Full) arrives — MUST BE BLOCKED (zero flicker to Full!)
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "full" }, models, "m1", 120),
      ).toBe(false);
      expect(h.options.yoloMode()).toBe(false);

      // 4) pull #2 (Full, initiated after click 2) arrives — MUST BE BLOCKED!
      h.confirmPull("sessions", clockAfterClick2);
      expect(
        h.options.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "full" },
          models,
          "m1",
          { rowRef: { id: "s1" }, updatedAt: 120 },
        ),
      ).toBe(false);
      expect(h.options.yoloMode()).toBe(false);

      // 5) session_data #3 (Ask) arrives — live horizon settles cleanly!
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, models, "m1", 130),
      ).toBe(true);
      expect(h.options.yoloMode()).toBe(false);

      // Even if a late pull from click 2 arrives again after live settled, mirror guard still blocks Full!
      expect(
        h.options.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "full" },
          models,
          "m1",
          { rowRef: { id: "s1" }, updatedAt: 120 },
        ),
      ).toBe(false);
      expect(h.options.yoloMode()).toBe(false);

      // 6) pull #3 (Ask, initiated after click 3 / live settle) arrives — mirror horizon settles!
      h.confirmPull("sessions", clockAfterClick3);
      expect(
        h.options.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "ask" },
          models,
          "m1",
          { rowRef: { id: "s1" }, updatedAt: 130 },
        ),
      ).toBe(true);
      expect(h.options.yoloMode()).toBe(false);
    } finally {
      h.dispose();
    }
  });

  test("protects A -> B -> A when session ALREADY held A before burst (both uncoalesced pull #1=B and coalesced pull=A)", () => {
    // Part 1: Without causalPullClock (pure state-machine transition tracking)
    let disposePure = () => {};
    const pureOpts = createRoot((dispose) => {
      disposePure = dispose;
      return createSessionOptions({
        send: () => {},
        getSessionId: () => "s1",
      });
    });
    try {
      // Session already holds Ask (A)
      pureOpts.reconcileMirrorSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1");
      expect(pureOpts.yoloMode()).toBe(false);

      // User clicks Full (B) -> Ask (A)
      pureOpts.setYoloMode(true);
      pureOpts.configureSession();
      pureOpts.setYoloMode(false);
      pureOpts.configureSession();
      expect(pureOpts.yoloMode()).toBe(false);

      // Pre-burst Ask re-evaluates on mirror BEFORE pull #1 (Full) arrives -> must NOT disarm!
      expect(
        pureOpts.reconcileMirrorSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1"),
      ).toBe(false);

      // Live stream delivers Full (#1) then Ask (#2)
      expect(
        pureOpts.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "full" }, ["m1"], "m1", 210),
      ).toBe(false);
      expect(
        pureOpts.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 220),
      ).toBe(true);
      expect(pureOpts.yoloMode()).toBe(false);

      // pull #1 (Full) arrives 200ms later -> MUST BE BLOCKED!
      expect(
        pureOpts.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "full" },
          ["m1"],
          "m1",
          { updatedAt: 210 },
        ),
      ).toBe(false);
      expect(pureOpts.yoloMode()).toBe(false);

      // pull #2 (Ask) arrives -> settles cleanly!
      expect(
        pureOpts.reconcileMirrorSelection(
          "s1",
          "m1",
          { effort: "medium", mode: "agentic", access: "ask" },
          ["m1"],
          "m1",
          { updatedAt: 220 },
        ),
      ).toBe(true);
      expect(pureOpts.yoloMode()).toBe(false);
    } finally {
      disposePure();
    }

    // Part 2: Coalesced pull (daemon 300ms debounce merges B + A into single pull=A)
    const h = createHarness("s1");
    try {
      const rowA0 = {
        id: "s1",
        model: "m1",
        updatedAt: 100,
        options: { effort: "medium", mode: "agentic", skills: [], access: "ask" },
      };
      h.setMirrorRow(rowA0);
      h.options.reconcileMirrorSelection("s1", "m1", rowA0.options, ["m1"], "m1", {
        rowRef: rowA0,
        updatedAt: 100,
      });

      h.options.setYoloMode(true);
      h.options.configureSession();
      h.options.setYoloMode(false);
      h.options.configureSession();

      // Live acks #1 (Full) then #2 (Ask)
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "full" }, ["m1"], "m1", 150),
      ).toBe(false);
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 160),
      ).toBe(true);

      // Cached rowA0 re-evaluates -> blocked
      expect(
        h.options.reconcileMirrorSelection("s1", "m1", rowA0.options, ["m1"], "m1", {
          rowRef: rowA0,
          updatedAt: 100,
        }),
      ).toBe(false);

      // Debounced pull initiated AFTER live settled delivers coalesced Ask directly
      const pullClock = h.getClock();
      h.confirmPull("sessions", pullClock);
      const rowA2 = {
        id: "s1",
        model: "m1",
        updatedAt: 160,
        options: { effort: "medium", mode: "agentic", skills: [], access: "ask" },
      };
      expect(
        h.options.reconcileMirrorSelection("s1", "m1", rowA2.options, ["m1"], "m1", {
          rowRef: rowA2,
          updatedAt: 160,
        }),
      ).toBe(true);
      expect(h.options.yoloMode()).toBe(false);
    } finally {
      h.dispose();
    }
  });

  test("isolates concurrent syncSkills (update_skills) and configureSession (configure_session) acks", () => {
    const h = createHarness("s1");
    try {
      h.catalog.build = { mode: "agentic", usable: "deny", approvalMode: "yolo" };
      h.catalog.plan = { mode: "agentic", usable: "deny", approvalMode: "ask" };

      const initialSkills = { build: { priority: 1, active: true, usable: "" } };
      const initialRow = {
        id: "s1",
        model: "m1",
        updatedAt: 100,
        options: { effort: "low", mode: "agentic", skills: [], access: "full" },
        skills: initialSkills,
        approvalMode: "yolo",
      };
      h.setMirrorRow(initialRow);
      h.options.setActiveModel("m1");
      h.options.applyOptions(initialRow.options);
      h.options.applyApprovalMode("yolo");
      h.options.applySessionSkills(initialSkills);

      // User switches Mode to Plan + enables review (usable: yolo), AND switches Effort=high + Ask!
      h.options.syncSkills(["plan", "review"], { review: "yolo" });
      h.options.setEffort("high");
      h.options.setYoloMode(false);
      h.options.configureSession();

      expect(h.options.selectedSkills()).toEqual(["plan", "review"]);
      expect(h.options.approvalMode()).toBe("ask");
      expect(h.options.yoloMode()).toBe(false);
      expect(h.options.effort()).toBe("high");

      // Case 1: session_data from update_skills arrives with NEW skills, but OLD options (effort: low, access: full)
      const newSkillsMap = {
        build: { priority: 0, active: false, usable: "" },
        plan: { priority: 1, active: true, usable: "" },
        review: { priority: 2, active: true, usable: "yolo" },
      };
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "low", mode: "agentic", access: "full" }, ["m1"], "m1", 110),
      ).toBe(false);
      expect(h.options.applyLiveSessionSkills("s1", newSkillsMap, "ask", 110)).toBe(true);

      // Neither effort/yoloMode nor skills reverted!
      expect(h.options.effort()).toBe("high");
      expect(h.options.yoloMode()).toBe(false);
      expect(h.options.selectedSkills()).toEqual(["plan", "review"]);
      expect(h.options.skillUsables().review).toBe("yolo");

      // Stale mirror still holds build + approvalMode: "yolo" + effort: "low" -> BOTH mirror guards reject!
      expect(
        h.options.reconcileMirrorSelection("s1", "m1", initialRow.options, ["m1"], "m1", {
          rowRef: initialRow,
          updatedAt: 100,
        }),
      ).toBe(false);
      expect(
        h.options.applyMirrorSessionSkills("s1", initialRow.skills, "yolo", {
          rowRef: initialRow,
          updatedAt: 100,
        }),
      ).toBe(false);
      expect(h.options.selectedSkills()).toEqual(["plan", "review"]);
      expect(h.options.approvalMode()).toBe("ask");
      expect(h.options.yoloMode()).toBe(false);

      // Case 2: session_data from configure_session arrives with NEW options + NEW skills
      expect(
        h.options.reconcileLiveSelection("s1", "m1", { effort: "high", mode: "agentic", access: "ask" }, ["m1"], "m1", 120),
      ).toBe(true);
      expect(h.options.applyLiveSessionSkills("s1", newSkillsMap, "ask", 120)).toBe(true);
      expect(h.options.effort()).toBe("high");
      expect(h.options.yoloMode()).toBe(false);
      expect(h.options.selectedSkills()).toEqual(["plan", "review"]);
    } finally {
      h.dispose();
    }
  });

  test("protects Draft mode Build -> Plan -> Learning and Build -> Plan -> Build against stale configDoc().lastSelection", () => {
    const h = createHarness("");
    try {
      const savedBuild0 = {
        model: "m1",
        effort: "medium",
        mode: "agentic",
        access: "full",
        skills: [{ name: "build" }],
      };
      h.setSavedSelection(savedBuild0);
      h.options.setActiveModel("m1");
      h.options.applyOptions(savedBuild0);
      h.options.resetDraftSkills(savedBuild0, true);
      expect(h.options.selectedSkills()).toEqual(["build"]);

      // User switches Build -> Plan -> Learning in Draft mode (all share mode: "agentic"!)
      h.options.syncSkills(["plan"]);
      h.options.configureSession();
      const clockPlan = h.getClock();

      h.options.syncSkills(["learning"]);
      h.options.configureSession();
      const clockLearning = h.getClock();

      // Immediate reactive re-run with cached savedBuild0 MUST NOT clear lastLocalSelection!
      expect(h.options.reconcileSavedSelection(savedBuild0)).toEqual(h.options.getLastLocalSelection());
      expect(h.options.getLastLocalSelection()?.skills).toEqual([{ name: "learning" }]);

      // Delayed pull #1 (Plan) arrives -> MUST NOT overwrite Learning!
      h.confirmPull("config", clockPlan);
      const savedPlan1 = { ...savedBuild0, skills: [{ name: "plan" }] };
      h.setSavedSelection(savedPlan1);
      const reconciled1 = h.options.reconcileSavedSelection(savedPlan1);
      expect(reconciled1?.skills).toEqual([{ name: "learning" }]);
      expect(h.options.getLastLocalSelection()).toBeDefined();

      // Delayed pull #2 (Learning) arrives -> clears lastLocalSelection cleanly!
      h.confirmPull("config", clockLearning);
      const savedLearning2 = { ...savedBuild0, skills: [{ name: "learning" }] };
      h.setSavedSelection(savedLearning2);
      const reconciled2 = h.options.reconcileSavedSelection(savedLearning2);
      expect(reconciled2).toBe(savedLearning2);
      expect(h.options.getLastLocalSelection()).toBeUndefined();

      // Now test A -> B -> A in Draft mode: Learning -> Plan -> Learning!
      h.options.syncSkills(["plan"]);
      h.options.configureSession();
      const clockB = h.getClock();

      h.options.syncSkills(["learning"]);
      h.options.configureSession();
      const clockA = h.getClock();

      // Pre-burst savedLearning2 does NOT disarm
      expect(h.options.reconcileSavedSelection(savedLearning2)?.skills).toEqual([{ name: "learning" }]);
      expect(h.options.getLastLocalSelection()).toBeDefined();

      // Intermediate pull (Plan) does NOT overwrite Learning!
      h.confirmPull("config", clockB);
      const savedPlanB = { ...savedBuild0, skills: [{ name: "plan" }] };
      expect(h.options.reconcileSavedSelection(savedPlanB)?.skills).toEqual([{ name: "learning" }]);
      expect(h.options.getLastLocalSelection()).toBeDefined();

      // Final pull (Learning) settles and clears lastLocalSelection!
      h.confirmPull("config", clockA);
      const savedLearningFinal = { ...savedBuild0, skills: [{ name: "learning" }] };
      expect(h.options.reconcileSavedSelection(savedLearningFinal)).toBe(savedLearningFinal);
      expect(h.options.getLastLocalSelection()).toBeUndefined();
    } finally {
      h.dispose();
    }
  });

  test("never snaps Effort slider back during live drag (setEffortPreviewing) and commits cleanly on release", () => {
    const h = createHarness("s1");
    try {
      h.options.setActiveModel("m1");
      h.options.setEffort("low");

      // PointerDown begins live slider drag across Low -> Medium -> High -> Max
      h.options.setEffortPreviewing(true);
      h.options.setEffort("medium");
      h.options.setEffort("high");
      h.options.setEffort("max");

      // Background session_data and mirror pulls arrive mid-drag carrying "low" (and a remote access change)
      h.options.reconcileLiveSelection("s1", "m1", { effort: "low", mode: "agentic", access: "ask" }, ["m1"], "m1", 150);
      h.options.reconcileMirrorSelection("s1", "m1", { effort: "low", mode: "agentic", access: "ask" }, ["m1"], "m1", {
        updatedAt: 150,
      });

      // Slider effort MUST stay at "max" while non-previewed options (access -> ask) still update!
      expect(h.options.effort()).toBe("max");
      expect(h.options.yoloMode()).toBe(false);

      // PointerUp releases preview and commits "max"
      h.options.setEffortPreviewing(false);
      h.options.setEffort("max");
      h.options.configureSession();

      // Stale mirror with "low" after release is blocked by pendingMirrorChoice!
      expect(
        h.options.reconcileMirrorSelection("s1", "m1", { effort: "low", mode: "agentic", access: "ask" }, ["m1"], "m1", {
          updatedAt: 150,
        }),
      ).toBe(false);
      expect(h.options.effort()).toBe("max");
    } finally {
      h.dispose();
    }
  });

  test("resetPending isolates session switches while resetPendingChoice preserves lastLocalSelection for new drafts", () => {
    const h = createHarness("s1");
    try {
      h.options.setActiveModel("gpt-5");
      h.options.setEffort("xhigh");
      h.options.setYoloMode(false);
      h.options.configureSession();

      // Case A: Switching from s1 to s2 calls resetPending() -> s1's pending choice cannot block s2
      h.options.resetPending();
      h.setSid("s2");
      expect(h.options.getLastLocalSelection()).toBeUndefined();
      expect(
        h.options.reconcileLiveSelection("s2", "claude-sonnet", { effort: "low", mode: "agentic", access: "full" }, ["claude-sonnet", "gpt-5"], "claude-sonnet"),
      ).toBe(true);
      expect(h.options.effort()).toBe("low");

      // Case B: User edits s2, then clicks New Conversation (resetPendingChoice) -> seeds Draft from lastLocalSelection!
      h.options.setEffort("max");
      h.options.syncSkills(["plan"]);
      h.options.configureSession();

      h.options.resetPendingChoice();
      h.setSid("");
      const remembered = h.options.getLastLocalSelection();
      expect(remembered?.effort).toBe("max");
      expect(remembered?.skills).toEqual([{ name: "plan" }]);
      h.options.applyOptions(remembered);
      h.options.resetDraftSkills(remembered, true);
      expect(h.options.effort()).toBe("max");
      expect(h.options.selectedSkills()).toEqual(["plan"]);
    } finally {
      h.dispose();
    }
  });

  test("preserves unshifted burst history across duplicate live acks and repeated reactive mirror/draft effect runs", () => {
    // 1. Live stream: Full -> Ask (#1) -> Plan (update_skills + configure_session(Ask)) -> Full (#2) -> Ask (#3)
    const h1 = createHarness("s1");
    try {
      const row0 = {
        id: "s1",
        model: "m1",
        updatedAt: 100,
        options: { effort: "medium", mode: "agentic", access: "full" },
        skills: { build: { priority: 1, active: true, usable: "inherit" } },
      };
      h1.setMirrorRow(row0);
      h1.options.reconcileMirrorSelection("s1", "m1", row0.options, ["m1"], "m1", { rowRef: row0, updatedAt: 100 });
      h1.options.applySessionSkills(row0.skills);

      h1.options.setYoloMode(false);
      h1.options.configureSession(); // Ask (#1)
      h1.options.syncSkills(["plan"]);
      h1.options.configureSession(); // Plan -> emits update_skills + configure_session(Ask)
      h1.options.setYoloMode(true);
      h1.options.configureSession(); // Full (#2)
      h1.options.setYoloMode(false);
      h1.options.configureSession(); // Ask (#3, final = Ask)

      // Three Ask session_data frames arrive (from #1, update_skills, and Plan's configure_session) before #2 (Full)!
      expect(h1.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 110)).toBe(false);
      expect(h1.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 120)).toBe(false);
      expect(h1.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 130)).toBe(false);
      // Intermediate Full (#2) arrives -> MUST NOT revert yoloMode back to true!
      expect(h1.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "full" }, ["m1"], "m1", 140)).toBe(false);
      expect(h1.options.yoloMode()).toBe(false);
      // Final Ask (#3) arrives -> settles cleanly!
      expect(h1.options.reconcileLiveSelection("s1", "m1", { effort: "medium", mode: "agentic", access: "ask" }, ["m1"], "m1", 150)).toBe(true);
      expect(h1.options.yoloMode()).toBe(false);
    } finally {
      h1.dispose();
    }

    // 2. Mirror choices & skills: 3-click Ask -> Full -> Ask and Plan -> Learning -> Plan with repeated effect re-runs on pull #1
    const h2 = createHarness("s1");
    try {
      const row0 = {
        id: "s1",
        model: "m1",
        updatedAt: 100,
        options: { effort: "medium", mode: "agentic", access: "full" },
        skills: { build: { priority: 1, active: true, usable: "inherit" } },
      };
      h2.setMirrorRow(row0);
      h2.options.reconcileMirrorSelection("s1", "m1", row0.options, ["m1"], "m1", { rowRef: row0, updatedAt: 100 });
      h2.options.applyMirrorSessionSkills("s1", row0.skills, "ask", { rowRef: row0, updatedAt: 100 });

      h2.options.setYoloMode(false);
      h2.options.configureSession(); // Ask (#1)
      h2.options.setYoloMode(true);
      h2.options.configureSession(); // Full (#2)
      h2.options.setYoloMode(false);
      h2.options.configureSession(); // Ask (#3)

      h2.options.syncSkills(["plan"]); // Plan (#1)
      h2.options.syncSkills(["learning"]); // Learning (#2)
      h2.options.syncSkills(["plan"]); // Plan (#3)

      // Cross-lane pull #1 started after WS clicks left client (while live session_data hasn't settled yet -> coalesced=false)
      h2.confirmPull("sessions", h2.getClock());
      const row1 = {
        id: "s1",
        model: "m1",
        updatedAt: 110,
        options: { effort: "medium", mode: "agentic", access: "ask" },
        skills: {
          build: { priority: 2, active: false, usable: "inherit" },
          plan: { priority: 1, active: true, usable: "inherit" },
        },
      };
      h2.setMirrorRow(row1);
      // Effect run #1 on row1:
      expect(h2.options.reconcileMirrorSelection("s1", "m1", row1.options, ["m1"], "m1", { rowRef: row1, updatedAt: 110 })).toBe(false);
      expect(h2.options.applyMirrorSessionSkills("s1", row1.skills, "ask", { rowRef: row1, updatedAt: 110 })).toBe(false);
      // Effect run #2 on the SAME row1 (e.g. gatewayModels() refreshed):
      expect(h2.options.reconcileMirrorSelection("s1", "m1", row1.options, ["m1", "m2"], "m1", { rowRef: row1, updatedAt: 110 })).toBe(false);
      expect(h2.options.applyMirrorSessionSkills("s1", row1.skills, "ask", { rowRef: row1, updatedAt: 110 })).toBe(false);

      // Pull #2 lands carrying intermediate #2 (Full + Learning) -> MUST be blocked!
      const row2 = {
        id: "s1",
        model: "m1",
        updatedAt: 120,
        options: { effort: "medium", mode: "agentic", access: "full" },
        skills: {
          build: { priority: 3, active: false, usable: "inherit" },
          plan: { priority: 2, active: false, usable: "inherit" },
          learning: { priority: 1, active: true, usable: "inherit" },
        },
      };
      h2.setMirrorRow(row2);
      expect(h2.options.reconcileMirrorSelection("s1", "m1", row2.options, ["m1", "m2"], "m1", { rowRef: row2, updatedAt: 120 })).toBe(false);
      expect(h2.options.applyMirrorSessionSkills("s1", row2.skills, "ask", { rowRef: row2, updatedAt: 120 })).toBe(false);
      expect(h2.options.yoloMode()).toBe(false);
      expect(h2.options.selectedSkills()).toEqual(["plan"]);

      // Pull #3 lands carrying final #3 (Ask + Plan) -> settles cleanly!
      const row3 = {
        id: "s1",
        model: "m1",
        updatedAt: 130,
        options: { effort: "medium", mode: "agentic", access: "ask" },
        skills: {
          build: { priority: 3, active: false, usable: "inherit" },
          learning: { priority: 2, active: false, usable: "inherit" },
          plan: { priority: 1, active: true, usable: "inherit" },
        },
      };
      h2.setMirrorRow(row3);
      expect(h2.options.reconcileMirrorSelection("s1", "m1", row3.options, ["m1", "m2"], "m1", { rowRef: row3, updatedAt: 130 })).toBe(true);
      expect(h2.options.applyMirrorSessionSkills("s1", row3.skills, "ask", { rowRef: row3, updatedAt: 130 })).toBe(true);
      expect(h2.options.yoloMode()).toBe(false);
      expect(h2.options.selectedSkills()).toEqual(["plan"]);
    } finally {
      h2.dispose();
    }

    // 3. Draft mode (without clock): 3-click Plan -> Learning -> Plan with repeated configDoc() re-runs on saved1
    const saved0 = { model: "m1", effort: "medium", mode: "agentic", access: "full", skills: [{ name: "build" }] };
    let curSaved = saved0;
    let disposeDraft = () => {};
    const draftOpts = createRoot((dispose) => {
      disposeDraft = dispose;
      return createSessionOptions({
        send: () => {},
        getSessionId: () => "",
        getSavedSelection: () => curSaved,
      });
    });
    try {
      draftOpts.setActiveModel("m1");
      draftOpts.applyOptions(saved0);
      draftOpts.resetDraftSkills(saved0, true);

      draftOpts.syncSkills(["plan"]);
      draftOpts.configureSession(); // Plan (#1)
      draftOpts.syncSkills(["learning"]);
      draftOpts.configureSession(); // Learning (#2)
      draftOpts.syncSkills(["plan"]);
      draftOpts.configureSession(); // Plan (#3)

      const saved1 = { model: "m1", effort: "medium", mode: "agentic", access: "full", skills: [{ name: "plan" }] };
      curSaved = saved1;
      // Effect run #1 and #2 on saved1:
      expect(draftOpts.reconcileSavedSelection(saved1)?.skills?.[0]?.name).toBe("plan");
      expect(draftOpts.reconcileSavedSelection(saved1)?.skills?.[0]?.name).toBe("plan");
      expect(draftOpts.getLastLocalSelection()).toBeDefined();

      // Pull #2 (Learning) arrives -> MUST NOT overwrite Plan!
      const saved2 = { model: "m1", effort: "medium", mode: "agentic", access: "full", skills: [{ name: "learning" }] };
      curSaved = saved2;
      expect(draftOpts.reconcileSavedSelection(saved2)?.skills?.[0]?.name).toBe("plan");
      expect(draftOpts.getLastLocalSelection()).toBeDefined();

      // Pull #3 (Plan) arrives -> settles and clears lastLocalSelection!
      const saved3 = { model: "m1", effort: "medium", mode: "agentic", access: "full", skills: [{ name: "plan" }] };
      curSaved = saved3;
      expect(draftOpts.reconcileSavedSelection(saved3)?.skills?.[0]?.name).toBe("plan");
      expect(draftOpts.getLastLocalSelection()).toBeUndefined();
    } finally {
      disposeDraft();
    }
  });

  test("coalesced Draft A -> B -> A in SignalDB clears lastLocalSelection on confirmed config pull and expires TTL cleanly so later remote config C applies", () => {
    // 1. Causal clock path: SignalDB deduplicates identical RcConfig doc (saved === savedA === lastLocalSelectionBaseline)
    let clock = 0;
    const confirmed = { sessions: 0, config: 0 };
    const savedA = { model: "m1", effort: "medium", mode: "agentic", access: "full", skills: [{ name: "build" }] };
    let curSaved = savedA;
    let dispose1 = () => {};
    const opts1 = createRoot((dispose) => {
      dispose1 = dispose;
      return createSessionOptions({
        send: () => {},
        getSessionId: () => "",
        getSavedSelection: () => curSaved,
        causalPullClock: {
          nextClock: () => ++clock,
          confirmedClock: (c) => confirmed[c],
        },
      });
    });
    try {
      opts1.setActiveModel("m1");
      opts1.applyOptions(savedA);
      opts1.resetDraftSkills(savedA, true);

      // User in Draft toggles A (medium) -> B (high) -> A (medium) within 300ms
      opts1.setEffort("high");
      opts1.configureSession();
      opts1.setEffort("medium");
      opts1.configureSession();
      const clockAfterABA = clock;

      // Before pull confirms, savedA must still be guarded as baseline
      expect(opts1.reconcileSavedSelection(savedA)?.effort).toBe("medium");
      expect(opts1.getLastLocalSelection()).toBeDefined();

      // At t=300ms, daemon config pull completes at clockAfterABA returning A; SignalDB keeps curSaved === savedA
      confirmed.config = clockAfterABA;
      expect(opts1.reconcileSavedSelection(curSaved)?.effort).toBe("medium");
      expect(opts1.getLastLocalSelection()).toBeUndefined();

      // Later, another tab updates default model/effort to C -> must apply cleanly!
      const savedC = { model: "gpt-5", effort: "max", mode: "agentic", access: "full", skills: [{ name: "build" }] };
      curSaved = savedC;
      confirmed.config = ++clock;
      const effectiveC = opts1.reconcileSavedSelection(savedC);
      expect(effectiveC?.model).toBe("gpt-5");
      expect(effectiveC?.effort).toBe("max");
      expect(opts1.getLastLocalSelection()).toBeUndefined();
    } finally {
      dispose1();
    }

    // 2. TTL safety path: offline local Draft edit survives past TTL against baseline, while stale burst expires for newer remote C
    const realNow = Date.now;
    let fakeNow = 1_000_000;
    Date.now = () => fakeNow;
    let dispose2 = () => {};
    let curSaved2 = savedA;
    const opts2 = createRoot((dispose) => {
      dispose2 = dispose;
      return createSessionOptions({
        send: () => {},
        getSessionId: () => "",
        getSavedSelection: () => curSaved2,
      });
    });
    try {
      opts2.setActiveModel("m1");
      opts2.applyOptions(savedA);
      opts2.resetDraftSkills(savedA, true);

      opts2.setEffort("high");
      opts2.configureSession();
      opts2.setEffort("medium");
      opts2.configureSession();

      // Advance past 8s TTL: while saved === baseline (e.g. offline), local selection remains intact
      fakeNow += 10_000;
      opts2.setEffort("xhigh");
      opts2.syncSkills(["plan"]);
      fakeNow += 10_000;
      expect(opts2.reconcileSavedSelection(savedA)?.effort).toBe("xhigh");
      expect(opts2.getLastLocalSelection()).toBeDefined();

      // Once a brand-new remote config C arrives past TTL, stale queue expires and C wins
      const savedC = { model: "gpt-5", effort: "max", mode: "agentic", access: "full", skills: [{ name: "learning" }] };
      curSaved2 = savedC;
      const effectiveAfterTtl = opts2.reconcileSavedSelection(savedC);
      expect(effectiveAfterTtl?.model).toBe("gpt-5");
      expect(effectiveAfterTtl?.effort).toBe("max");
      expect(opts2.getLastLocalSelection()).toBeUndefined();
    } finally {
      Date.now = realNow;
      dispose2();
    }
  });

  test("EffortPickerBody unmount during active drag reverts uncommitted preview only while still previewing and never clobbers batched session switches", async () => {
    const root = path.join(import.meta.dir, "..");
    const effortSrc = readFileSync(
      path.join(root, "web/src/indirect-code/components/EffortPickerBody.tsx"),
      "utf8",
    );
    const pageSrc = readFileSync(
      path.join(root, "web/src/indirect-code/IndirectCodePage.tsx"),
      "utf8",
    );

    // EffortPickerBody onCleanup checks stillPreviewing before reverting uncommitted drag preview
    expect(effortSrc).toMatch(
      /onCleanup\(\(\)\s*=>\s*\{[\s\S]*?const startLvl = startCommittedLevel;\s*const stillPreviewing = props\.effortPreviewing \? untrack\(props\.effortPreviewing\) : true;[\s\S]*?if \(stillPreviewing\) \{\s*props\.onEffortPreviewChange\?\.\(false\);[\s\S]*?if \(startLvl && startLvl !== currentLvl\) \{\s*props\.onEffortPreview\(startLvl\);\s*\}\s*\}/,
    );
    expect(pageSrc).toContain("effortPreviewing={options.effortPreviewing}");

    // IndirectCodePage selectSession, startNewConversation, and session_created close open menus & clear previewing before applying options
    expect(pageSrc).toMatch(/function selectSession[\s\S]*?closeMenus\(\);\s*options\.resetPending\(\);/);
    expect(pageSrc).toMatch(/function startNewConversation[\s\S]*?closeMenus\(\);\s*options\.resetPendingChoice\(\);/);
    expect(pageSrc).toMatch(/case "session_created":[\s\S]*?closeMenus\(\);\s*options\.setEffortPreviewing\(false\);/);

    // Live browser-runtime Solid reactivity test (bun test resolves bare "solid-js" to SSR server.js,
    // so load client solid.js explicitly to exercise real <Show> disposal inside batch())
    const solidClientPath = path.join(root, "node_modules/solid-js/dist/solid.js");
    const solidClient = (await import(solidClientPath)) as typeof import("solid-js");

    solidClient.createRoot((dispose) => {
      try {
        const [menuOpen, setMenuOpen] = solidClient.createSignal(true);
        const opts = createSessionOptions({
          send: () => {},
          getSessionId: () => "s1",
        });
        opts.setEffort("medium");

        let activePointerId: number | null = 1;
        let startCommittedLevel: string | null = "medium";
        opts.setEffortPreviewing(true);
        opts.setEffort("max");

        const mountPickerCleanup = () =>
          solidClient.Show({
            get when() {
              return menuOpen();
            },
            get children() {
              solidClient.onCleanup(() => {
                if (activePointerId !== null) {
                  const startLvl = startCommittedLevel;
                  const stillPreviewing = solidClient.untrack(opts.effortPreviewing);
                  activePointerId = null;
                  startCommittedLevel = null;
                  if (stillPreviewing) {
                    opts.setEffortPreviewing(false);
                    const currentLvl = solidClient.untrack(opts.effort);
                    if (startLvl && startLvl !== currentLvl) {
                      opts.setEffort(startLvl);
                    }
                  }
                }
              });
              return null;
            },
          });

        // A) Escape / outside click closes menu without resetting previewing -> reverts max -> medium
        const viewA = mountPickerCleanup();
        void viewA;
        setMenuOpen(false);
        expect(opts.effort()).toBe("medium");
        expect(opts.effortPreviewing()).toBe(false);

        // B) Batched selectSession("s2") during active drag -> s2's "low" MUST NOT be clobbered by s1's "medium"!
        setMenuOpen(true);
        activePointerId = 2;
        startCommittedLevel = "medium";
        opts.setEffortPreviewing(true);
        opts.setEffort("max");
        const viewB = mountPickerCleanup();
        void viewB;

        solidClient.batch(() => {
          setMenuOpen(false); // closeMenus()
          opts.resetPending(); // clears effortPreviewing -> false
          opts.applyOptions({ effort: "low", mode: "agentic", access: "full" });
        });
        expect(opts.effort()).toBe("low");
        expect(opts.effortPreviewing()).toBe(false);
      } finally {
        dispose();
      }
    });
  });
});

describe("useTranscript routine session_data fast-path & safety invariants", () => {
  test("skips re-normalization on routine idle session_data while advancing transcriptOrder cursor and still normalizing real mutations", async () => {
    const { getWorkerPosts, restore } = installMinimalDocument();
    const sent: any[] = [];
    const [sid] = createSignal("s1");
    let disposeRoot = () => {};

    const { t, tc } = createRoot((dispose) => {
      disposeRoot = dispose;
      const transcript = createTranscript({
        send: (cmd) => sent.push(cmd),
        isOpen: () => true,
        getSessionId: sid,
        getHostId: () => "host-a",
        toast: () => {},
        showChoice: async () => null,
        onTurnIdle: () => {},
        onUsageContext: () => {},
      });
      const turnChanges = createTurnChanges({
        send: (cmd) => sent.push(cmd),
        getSessionId: sid,
      });
      return { t: transcript, tc: turnChanges };
    });

    try {
      // Build a 60-message conversation (>= WORKER_MIN_MESSAGES=50)
      const rawMessages = Array.from({ length: 60 }, (_, i) => ({
        id: `m-${i + 1}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Message body number ${i + 1}` }],
        turnIndex: Math.floor(i / 2) + 1,
      }));
      const baseHistory = { oldestTurn: 1, newestTurn: 30, firstIndex: 0, hasOlder: false, totalTurns: 30 };
      const initialBalloons = [
        {
          turnIndex: 30,
          messageIndex: 59,
          files: [{ path: "src/app.ts", status: "modified", additions: 4, deletions: 1 }],
        },
      ];

      // 1. Initial get_session load (with requestId) -> runs full normalization
      t.fetchSession("s1");
      const reqId = sent.find((c) => c.type === "get_session")?.requestId;
      expect(typeof reqId).toBe("string");
      expect(t.noteSessionDataRequestGuard(reqId)).toBe(false);

      t.applySnapshot(
        "s1",
        {
          id: "s1",
          status: "idle",
          messages: rawMessages,
          history: baseHistory,
          transcript: { stream: "stream-1", seq: 10 },
          todos: [{ content: "Initial todo", status: "in_progress" }],
          fileBalloons: initialBalloons,
          context: { model: "m1", usedTokens: 1200, windowTokens: 200000, percent: 1 },
        },
        () => tc.applySnapshot({ status: "idle", fileBalloons: initialBalloons }),
        { requestId: reqId },
      );

      await new Promise((r) => setTimeout(r, 20));
      expect(t.messages().length).toBe(60);
      expect(getWorkerPosts()).toBe(1);
      const msgsRefBefore = t.messages();
      const balloonsRefBefore = tc.balloons()[0];
      sent.length = 0;

      // 2. Routine unrequested session_data (from configure_session / update_skills):
      // identical messages, seq advances 10 -> 11, todos + context updated!
      let onAppliedSync = false;
      t.applySnapshot(
        "s1",
        {
          id: "s1",
          status: "idle",
          messages: rawMessages,
          history: baseHistory,
          transcript: { stream: "stream-1", seq: 11 },
          todos: [{ id: "t1", text: "Updated todo synchronously", status: "completed" }],
          fileBalloons: initialBalloons,
          context: { model: "gpt-5", usedTokens: 1200, windowTokens: 400000, percent: 0.3 },
        },
        () => {
          onAppliedSync = true;
          tc.applySnapshot({ status: "idle", fileBalloons: initialBalloons });
        },
      );

      // Must have executed synchronously on the same tick without touching messages() or Worker!
      expect(onAppliedSync).toBe(true);
      expect(getWorkerPosts()).toBe(1);
      expect(t.todos()[0]?.text).toBe("Updated todo synchronously");
      expect(t.sessionContexts()["s1"]?.model).toBe("gpt-5");
      expect(t.messages()).toBe(msgsRefBefore);
      expect(tc.balloons()[0]).toBe(balloonsRefBefore);

      // Prove transcriptOrder cursor advanced to seq=11: an event at seq=12 applies cleanly with 0 gap resyncs!
      t.handleStatusEvent({
        type: "session_status",
        sessionId: "s1",
        status: "idle",
        transcript: { stream: "stream-1", seq: 12 },
      } as any);
      expect(sent.filter((c) => c.type === "get_session").length).toBe(0);

      // 3. Genuine middle-message edit in session_data MUST NOT be skipped!
      const editedMessages = rawMessages.map((m, idx) =>
        idx === 24 ? { ...m, content: [{ type: "text", text: "Edited user prompt in middle of chat" }] } : m,
      );
      t.applySnapshot(
        "s1",
        {
          id: "s1",
          status: "idle",
          messages: editedMessages,
          history: baseHistory,
          transcript: { stream: "stream-1", seq: 13 },
        },
        undefined,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(getWorkerPosts()).toBe(2);
      expect(t.messages()).not.toBe(msgsRefBefore);
      expect(JSON.stringify(t.messages()[24])).toContain("Edited user prompt in middle of chat");

      // 4. Streaming snapshot (liveMessage) MUST NOT be skipped!
      t.applySnapshot(
        "s1",
        {
          id: "s1",
          status: "running",
          messages: editedMessages,
          liveMessage: {
            id: "live-1",
            role: "assistant",
            content: [{ type: "text", text: "Streaming live response..." }],
            turnIndex: 31,
          },
          history: baseHistory,
          transcript: { stream: "stream-1", seq: 14 },
        },
        undefined,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(getWorkerPosts()).toBe(3);
      expect(t.messages().length).toBe(61);
      expect(JSON.stringify(t.messages()[60])).toContain("Streaming live response...");
    } finally {
      disposeRoot();
      restore();
    }
  });
});
