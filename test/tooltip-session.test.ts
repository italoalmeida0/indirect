import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";
import {
  createTooltipSession,
  getDelegatedTooltipText,
  isTooltipSuppressedTarget,
  resolveTooltipPlacement,
  TOOLTIP_ANCHOR_ATTR,
  TOOLTIP_COLD_DELAY_MS,
  TOOLTIP_WARM_COOLDOWN_MS,
  type TooltipSession,
  type TooltipSessionTimers,
} from "../web/src/ds/tooltip-session";
import type { bindTooltipTrigger as BindTooltipTriggerFn } from "../web/src/ds/components/tooltip";
import type {
  bindDelegatedTooltips as BindDelegatedTooltipsFn,
  claimRemoteHintsOwner as ClaimRemoteHintsOwnerFn,
  DelegatedTooltipState,
  getActiveRemoteHintsCount as GetActiveRemoteHintsCountFn,
} from "../web/src/indirect-code/presentation";

const repoRoot = path.join(import.meta.dir, "..");

let bundleTmpDir = "";
let sharedSession: TooltipSession;
let bindTooltipTrigger: typeof BindTooltipTriggerFn;
let bindDelegatedTooltips: typeof BindDelegatedTooltipsFn;
let claimRemoteHintsOwner: typeof ClaimRemoteHintsOwnerFn;
let getActiveRemoteHintsCount: typeof GetActiveRemoteHintsCountFn;

beforeAll(async () => {
  bundleTmpDir = mkdtempSync(path.join(os.tmpdir(), "indirect-tooltip-session-"));
  const bundle = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL("../web/src/ds/tooltip-session.ts", import.meta.url)),
      fileURLToPath(new URL("../web/src/ds/components/tooltip.tsx", import.meta.url)),
      fileURLToPath(new URL("../web/src/indirect-code/presentation.tsx", import.meta.url)),
    ],
    splitting: true,
    target: "browser",
    outdir: bundleTmpDir,
    plugins: [iconifyPlugin, solidPlugin],
  });
  if (!bundle.success) {
    throw new Error(bundle.logs.map(String).join("\n"));
  }
  const sessionMod = await import(
    pathToFileURL(path.join(bundleTmpDir, "ds/tooltip-session.js")).href
  );
  const tooltipMod = await import(
    pathToFileURL(path.join(bundleTmpDir, "ds/components/tooltip.js")).href
  );
  const presentationMod = await import(
    pathToFileURL(path.join(bundleTmpDir, "indirect-code/presentation.js")).href
  );
  sharedSession = sessionMod.tooltipSession;
  bindTooltipTrigger = tooltipMod.bindTooltipTrigger;
  bindDelegatedTooltips = presentationMod.bindDelegatedTooltips;
  claimRemoteHintsOwner = presentationMod.claimRemoteHintsOwner;
  getActiveRemoteHintsCount = presentationMod.getActiveRemoteHintsCount;
});

afterAll(() => {
  if (bundleTmpDir) {
    rmSync(bundleTmpDir, { recursive: true, force: true });
  }
});

function createFakeClock() {
  let nowMs = 0;
  let nextId = 1;
  const scheduled = new Map<number, { due: number; fn: () => void }>();

  const timers: TooltipSessionTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      scheduled.set(id, { due: nowMs + ms, fn });
      return id as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (id) => {
      scheduled.delete(id as unknown as number);
    },
  };

  const advance = (deltaMs: number) => {
    const target = nowMs + deltaMs;
    while (true) {
      let earliestId: number | null = null;
      let earliestDue = Infinity;
      for (const [id, entry] of scheduled) {
        if (entry.due <= target && entry.due < earliestDue) {
          earliestDue = entry.due;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const item = scheduled.get(earliestId)!;
      scheduled.delete(earliestId);
      nowMs = item.due;
      item.fn();
    }
    nowMs = target;
  };

  return {
    timers,
    advance,
    pendingCount: () => scheduled.size,
  };
}

type ListenerRecord = {
  type: string;
  fn: (event: any) => void;
  capture: boolean;
};

class MockElement {
  readonly nodeType = 1;
  readonly tagName: string;
  parentElement: MockElement | null = null;
  readonly children: MockElement[] = [];
  isConnected = true;
  focusVisible = false;
  private readonly attrs = new Map<string, string>();
  private readonly classes = new Set<string>();
  private readonly listeners: ListenerRecord[] = [];
  private readonly observers: Set<{
    cb: () => void;
    filter?: Set<string>;
    subtree?: boolean;
  }> = new Set();

  constructor(tagName = "div", attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) {
      this.attrs.set(k, v);
    }
  }

  readonly classList = {
    add: (c: string) => {
      this.classes.add(c);
    },
    remove: (c: string) => {
      this.classes.delete(c);
    },
    contains: (c: string) => this.classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const next = force ?? !this.classes.has(c);
      if (next) this.classes.add(c);
      else this.classes.delete(c);
      return next;
    },
  };

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    child.setConnectedRecursive(this.isConnected);
    this.children.push(child);
    this.notifyChildListMutation();
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (parent) {
      const idx = parent.children.indexOf(this);
      if (idx !== -1) parent.children.splice(idx, 1);
      this.parentElement = null;
      this.setConnectedRecursive(false);
      parent.notifyChildListMutation();
    } else {
      this.setConnectedRecursive(false);
    }
  }

  private setConnectedRecursive(connected: boolean): void {
    this.isConnected = connected;
    for (const c of this.children) c.setConnectedRecursive(connected);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.notifyAttributeMutation(name);
  }

  removeAttribute(name: string): void {
    const existed = this.attrs.delete(name);
    if (existed) this.notifyAttributeMutation(name);
  }

  contains(other: unknown): boolean {
    let cur: unknown = other;
    while (cur && typeof cur === "object") {
      if (cur === this) return true;
      cur = (cur as MockElement).parentElement;
    }
    return false;
  }

  matches(selector: string): boolean {
    if (selector === ":focus-visible") return this.focusVisible;
    return selector
      .split(",")
      .map((s) => s.trim())
      .some((part) => this.matchesSingle(part));
  }

  private matchesSingle(part: string): boolean {
    if (!part) return false;
    if (part === ":focus-visible") return this.focusVisible;
    if (part === '[aria-expanded="true"]') return this.getAttribute("aria-expanded") === "true";
    if (part === '[data-tip-busy]:not([data-tip-busy="false"])') {
      return this.hasAttribute("data-tip-busy") && this.getAttribute("data-tip-busy") !== "false";
    }
    const attrExact = part.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
    if (attrExact) return this.getAttribute(attrExact[1]!) === attrExact[2]!;
    const attrHas = part.match(/^\[([a-zA-Z0-9_-]+)\]$/);
    if (attrHas) return this.hasAttribute(attrHas[1]!);
    return this.tagName.toLowerCase() === part.toLowerCase();
  }

  closest(selector: string): MockElement | null {
    if (this.matches(selector)) return this;
    return this.parentElement ? this.parentElement.closest(selector) : null;
  }

  querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }

  addEventListener(type: string, fn: (event: any) => void, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    this.listeners.push({ type, fn, capture });
  }

  removeEventListener(
    type: string,
    fn: (event: any) => void,
    opts?: boolean | { capture?: boolean },
  ) {
    const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
    const idx = this.listeners.findIndex(
      (l) => l.type === type && l.fn === fn && l.capture === capture,
    );
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  dispatchOnSelf(type: string, init: Record<string, any> = {}): void {
    const event = { type, target: this, currentTarget: this, ...init };
    for (const l of [...this.listeners]) {
      if (l.type === type) l.fn(event);
    }
  }

  registerObserver(obs: { cb: () => void; filter?: Set<string>; subtree?: boolean }) {
    this.observers.add(obs);
  }

  unregisterObserver(obs: { cb: () => void; filter?: Set<string>; subtree?: boolean }) {
    this.observers.delete(obs);
  }

  private notifyAttributeMutation(attrName: string, isSelf = true) {
    for (const obs of [...this.observers]) {
      if (!isSelf && !obs.subtree) continue;
      if (!obs.filter || obs.filter.has(attrName)) {
        obs.cb();
      }
    }
    this.parentElement?.notifyAttributeMutation(attrName, false);
  }

  private notifyChildListMutation(isSelf = true) {
    for (const obs of [...this.observers]) {
      if (obs.subtree || isSelf) {
        obs.cb();
      }
    }
    this.parentElement?.notifyChildListMutation(false);
  }
}

function createMockDom() {
  const documentElement = new MockElement("html");
  const body = new MockElement("body");
  documentElement.appendChild(body);

  const docListeners: ListenerRecord[] = [];
  const winListeners: ListenerRecord[] = [];

  const doc = {
    documentElement,
    body,
    activeElement: null as MockElement | null,
    hidden: false,
    addEventListener(
      type: string,
      fn: (event: any) => void,
      opts?: boolean | { capture?: boolean },
    ) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      docListeners.push({ type, fn, capture });
    },
    removeEventListener(
      type: string,
      fn: (event: any) => void,
      opts?: boolean | { capture?: boolean },
    ) {
      const capture = typeof opts === "boolean" ? opts : Boolean(opts?.capture);
      const idx = docListeners.findIndex(
        (l) => l.type === type && l.fn === fn && l.capture === capture,
      );
      if (idx !== -1) docListeners.splice(idx, 1);
    },
    dispatch(type: string, target: MockElement, init: Record<string, any> = {}) {
      const path: MockElement[] = [];
      let cur: MockElement | null = target;
      while (cur) {
        path.push(cur);
        cur = cur.parentElement;
      }
      const event = { type, target, ...init };
      // 1. Document capture
      for (const l of [...docListeners]) {
        if (l.type === type && l.capture) l.fn(event);
      }
      // 2. Ancestor capture -> target -> bubble
      for (let i = path.length - 1; i >= 0; i--) {
        path[i]!.dispatchOnSelf(type, { ...init, target });
      }
      // 3. Document bubble
      for (const l of [...docListeners]) {
        if (l.type === type && !l.capture) l.fn(event);
      }
    },
  };

  const win = {
    addEventListener(type: string, fn: (event: any) => void) {
      winListeners.push({ type, fn, capture: false });
    },
    removeEventListener(type: string, fn: (event: any) => void) {
      const idx = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (idx !== -1) winListeners.splice(idx, 1);
    },
    dispatch(type: string, init: Record<string, any> = {}) {
      const event = { type, target: win, ...init };
      for (const l of [...winListeners]) {
        if (l.type === type) l.fn(event);
      }
    },
  };

  class MockMutationObserver {
    private readonly cb: () => void;
    private readonly registrations: Array<{
      target: MockElement;
      record: { cb: () => void; filter?: Set<string>; subtree?: boolean };
    }> = [];

    constructor(cb: () => void) {
      this.cb = cb;
    }

    observe(
      target: MockElement,
      options?: { attributes?: boolean; attributeFilter?: string[]; subtree?: boolean; childList?: boolean },
    ) {
      const record = {
        cb: this.cb,
        filter: options?.attributeFilter ? new Set(options.attributeFilter) : undefined,
        subtree: options?.subtree,
      };
      target.registerObserver(record);
      this.registrations.push({ target, record });
    }

    disconnect() {
      for (const { target, record } of this.registrations) {
        target.unregisterObserver(record);
      }
      this.registrations.length = 0;
    }
  }

  return {
    doc,
    win,
    body,
    documentElement,
    MockMutationObserver,
    docListenerCount: () => docListeners.length,
    winListenerCount: () => winListeners.length,
  };
}

describe("tweakgrid-dev warm-roving tooltip state machine", () => {
  test("1. cold hover < 500ms never opens; >= 500ms opens with instant = false and activates warm state", () => {
    expect(TOOLTIP_COLD_DELAY_MS).toBe(500);
    expect(TOOLTIP_WARM_COOLDOWN_MS).toBe(500);

    const clock = createFakeClock();
    const session = createTooltipSession({ timers: clock.timers });
    const events: string[] = [];

    const triggerA = new MockElement("button", { "data-tip": "Add context" });
    const entryA = {
      key: "a",
      trigger: triggerA as unknown as Element,
      open: (instant: boolean) => events.push(`open:a:${instant ? "instant" : "cold"}`),
      close: () => events.push("close:a"),
    };

    // Casual pass of 150ms (the old buggy delay) and even 499ms must NEVER open or warm
    session.enter(entryA);
    clock.advance(150);
    expect(events).toEqual([]);
    expect(session.isWarm()).toBe(false);

    clock.advance(349); // 499ms total
    expect(events).toEqual([]);
    expect(session.isWarm()).toBe(false);
    session.leave("a");
    clock.advance(200);
    expect(events).toEqual([]);
    expect(session.isWarm()).toBe(false);
    expect(clock.pendingCount()).toBe(0);

    // Deliberate hover >= 500ms opens with instant = false and warms session
    session.enter(entryA);
    clock.advance(499);
    expect(events).toEqual([]);
    clock.advance(1); // 500ms
    expect(events).toEqual(["open:a:cold"]);
    expect(session.isWarm()).toBe(true);
    expect(session.activeKey()).toBe("a");
  });

  test("2. warm roving across multiple triggers within 500ms opens synchronously (0ms, instant = true) and resets cooldown each time", () => {
    const clock = createFakeClock();
    const session = createTooltipSession({ timers: clock.timers });
    const openSet = new Set<string>();
    const log: string[] = [];

    const mk = (id: string, label: string) => {
      const el = new MockElement("button", { "data-rc-tip": label });
      return {
        key: id,
        trigger: el as unknown as Element,
        open: (instant: boolean) => {
          openSet.add(id);
          expect(openSet.size).toBe(1); // Never two tooltips open simultaneously
          log.push(`open:${id}:${instant ? "instant" : "cold"}`);
        },
        close: () => {
          openSet.delete(id);
          log.push(`close:${id}`);
        },
      };
    };

    const addBtn = mk("add", "Add context");
    const modeBtn = mk("mode", "Mode & skills");
    const permBtn = mk("perm", "Permissions: Full access");
    const modelBtn = mk("model", "Effort & model");

    // Cold open on +
    session.enter(addBtn);
    clock.advance(500);
    expect(log).toEqual(["open:add:cold"]);

    // Leave + -> wait 350ms (< 500ms) -> enter Mode: opens in 0ms with instant = true
    session.leave("add");
    expect(openSet.size).toBe(0);
    clock.advance(350);
    expect(session.isWarm()).toBe(true);

    session.enter(modeBtn);
    expect(log).toEqual(["open:add:cold", "close:add", "open:mode:instant"]);

    // Leave Mode -> wait another 450ms (800ms since leaving +, proving cooldown reset!) -> enter Permissions
    session.leave("mode");
    clock.advance(450);
    expect(session.isWarm()).toBe(true);
    session.enter(permBtn);
    expect(log).toEqual([
      "open:add:cold",
      "close:add",
      "open:mode:instant",
      "close:mode",
      "open:perm:instant",
    ]);

    // Direct 0ms jump from Permissions -> Effort & model (without prior leave) dismisses perm synchronously first
    session.enter(modelBtn);
    expect(openSet.has("perm")).toBe(false);
    expect(openSet.has("model")).toBe(true);
    expect(log.at(-2)).toBe("close:perm");
    expect(log.at(-1)).toBe("open:model:instant");
  });

  test("3. leaving all triggers for >= 500ms expires warm state back to cold (500ms required again)", () => {
    const clock = createFakeClock();
    const session = createTooltipSession({ timers: clock.timers });
    const log: string[] = [];

    const btn = new MockElement("button", { "data-tip": "Refresh" });
    const entry = {
      key: "refresh",
      trigger: btn as unknown as Element,
      open: (instant: boolean) => log.push(`open:${instant ? "instant" : "cold"}`),
      close: () => log.push("close"),
    };

    session.enter(entry);
    clock.advance(500);
    expect(session.isWarm()).toBe(true);
    expect(log).toEqual(["open:cold"]);

    session.leave("refresh");
    expect(log).toEqual(["open:cold", "close"]);
    clock.advance(499);
    expect(session.isWarm()).toBe(true);

    clock.advance(1); // 500ms elapsed outside triggers -> cold again
    expect(session.isWarm()).toBe(false);

    // Re-entering now requires full 500ms cold hover with instant = false
    session.enter(entry);
    clock.advance(250);
    expect(log).toEqual(["open:cold", "close"]);
    clock.advance(250);
    expect(log).toEqual(["open:cold", "close", "open:cold"]);
  });

  test("4. pointerdown immediately closes, resets isWarm = false, and suppresses re-opening on the same element until pointer leaves it", () => {
    const clock = createFakeClock();
    const session = createTooltipSession({ timers: clock.timers });
    const log: string[] = [];

    const btnA = new MockElement("button", { "data-rc-tip": "Copy" });
    const childIcon = btnA.appendChild(new MockElement("svg"));
    const btnB = new MockElement("button", { "data-rc-tip": "Edit" });
    const outside = new MockElement("div");

    const entryA = {
      key: btnA,
      trigger: btnA as unknown as Element,
      open: (instant: boolean) => log.push(`open:A:${instant ? "instant" : "cold"}`),
      close: () => log.push("close:A"),
    };
    const entryB = {
      key: btnB,
      trigger: btnB as unknown as Element,
      open: (instant: boolean) => log.push(`open:B:${instant ? "instant" : "cold"}`),
      close: () => log.push("close:B"),
    };

    session.enter(entryA);
    clock.advance(500);
    expect(log).toEqual(["open:A:cold"]);
    expect(session.isWarm()).toBe(true);

    // User clicks btnA -> closes immediately, resets isWarm = false, suppresses btnA
    session.hardReset(btnA as unknown as Element);
    expect(log).toEqual(["open:A:cold", "close:A"]);
    expect(session.isWarm()).toBe(false);
    expect(session.suppressedElement()).toBe(btnA as unknown as Element);

    // Stationary release / child SVG swap inside btnA must NOT re-arm tooltip
    session.notifyPointerOut(childIcon, null); // detached old icon inside btnA
    expect(session.suppressedElement()).toBe(btnA as unknown as Element);
    session.enter(entryA);
    clock.advance(1000);
    expect(log).toEqual(["open:A:cold", "close:A"]);

    // Moving pointer onto outside space clears stationary suppression on btnA
    session.notifyPointerOut(btnA, outside);
    expect(session.suppressedElement()).toBeNull();

    // Re-entering btnA now works again (cold 500ms)
    session.enter(entryA);
    clock.advance(500);
    expect(log).toEqual(["open:A:cold", "close:A", "open:A:cold"]);

    // Clicking btnA then moving directly to neighbor btnB clears suppression on btnA and starts cold 500ms on btnB
    session.hardReset(btnA as unknown as Element);
    session.enter(entryB);
    expect(session.suppressedElement()).toBeNull();
    clock.advance(200);
    expect(log.at(-1)).toBe("close:A"); // still waiting for cold 500ms because pointerdown reset isWarm!
    clock.advance(300);
    expect(log.at(-1)).toBe("open:B:cold");
  });

  test("5. isTooltipSuppressedTarget handles aria-expanded='true', data-tip-busy, empty text, interactive ancestors, and <Tooltip> children", () => {
    expect(isTooltipSuppressedTarget(null)).toBe(true);

    const normal = new MockElement("button", { "data-rc-tip": "Effort & model", "aria-expanded": "false" });
    expect(isTooltipSuppressedTarget(normal as unknown as Element)).toBe(false);

    // Open menu trigger (`aria-expanded="true"`) suppresses tooltip
    normal.setAttribute("aria-expanded", "true");
    expect(isTooltipSuppressedTarget(normal as unknown as Element)).toBe(true);

    // Explicit busy flag suppresses tooltip
    const busy = new MockElement("button", { "data-tip": "Saving", "data-tip-busy": "" });
    expect(isTooltipSuppressedTarget(busy as unknown as Element)).toBe(true);

    // Empty / whitespace text suppresses tooltip
    const empty = new MockElement("button", { "data-tip": "   \n  " });
    expect(isTooltipSuppressedTarget(empty as unknown as Element)).toBe(true);
    expect(getDelegatedTooltipText(empty as unknown as Element)).toBe("");

    // Child span with data-tip inside an open <button aria-expanded="true"> is suppressed
    const parentMenuBtn = new MockElement("button", { "aria-expanded": "true" });
    const innerSpan = parentMenuBtn.appendChild(new MockElement("span", { "data-tip": "Project" }));
    expect(isTooltipSuppressedTarget(innerSpan as unknown as Element)).toBe(true);

    // Non-interactive accordion container <div aria-expanded="true"> does NOT suppress buttons inside it
    const openAccordion = new MockElement("div", { "aria-expanded": "true" });
    const copyBtn = openAccordion.appendChild(new MockElement("button", { "data-rc-tip": "Copy" }));
    expect(isTooltipSuppressedTarget(copyBtn as unknown as Element)).toBe(false);

    // <Tooltip> anchor wrapper checks child button's aria-expanded="true"
    const dsAnchor = new MockElement("span", { [TOOLTIP_ANCHOR_ATTR]: "" });
    const dsChildBtn = dsAnchor.appendChild(new MockElement("button", { "aria-expanded": "false" }));
    expect(isTooltipSuppressedTarget(dsAnchor as unknown as Element)).toBe(false);
    dsChildBtn.setAttribute("aria-expanded", "true");
    expect(isTooltipSuppressedTarget(dsAnchor as unknown as Element)).toBe(true);

    // Placement attribute helper
    expect(resolveTooltipPlacement(new MockElement("button", { "data-tip-placement": "right" }) as unknown as Element)).toBe("right");
    expect(resolveTooltipPlacement(new MockElement("button", { "data-rc-tip-placement": "bottom" }) as unknown as Element)).toBe("bottom");
    expect(resolveTooltipPlacement(new MockElement("button") as unknown as Element)).toBe("top");
  });
});

describe("DOM integration: <Tooltip> + delegated [data-rc-tip]/[data-tip] + smart contextual suppression", () => {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  const prevMO = (globalThis as any).MutationObserver;
  let dom: ReturnType<typeof createMockDom>;
  let clock: ReturnType<typeof createFakeClock>;

  beforeEach(() => {
    dom = createMockDom();
    clock = createFakeClock();
    (globalThis as any).document = dom.doc;
    (globalThis as any).window = dom.win;
    (globalThis as any).MutationObserver = dom.MockMutationObserver;
    sharedSession.setTimers(clock.timers);
  });

  afterEach(() => {
    sharedSession.setTimers();
    if (prevDoc === undefined) delete (globalThis as any).document;
    else (globalThis as any).document = prevDoc;
    if (prevWin === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prevWin;
    if (prevMO === undefined) delete (globalThis as any).MutationObserver;
    else (globalThis as any).MutationObserver = prevMO;
  });

  test("6. mutual exclusion, warm-state sharing, buttons !== 0, touch/mobile, :focus-visible, scroll/wheel/blur, and live MutationObserver between <Tooltip> and [data-rc-tip]/[data-tip]", () => {
    let dsState: { open: boolean; instant: boolean } = { open: false, instant: false };
    const remoteBox: { current: DelegatedTooltipState | null } = { current: null };

    // Mount DS <Tooltip> trigger
    const dsAnchor = dom.body.appendChild(new MockElement("span", { [TOOLTIP_ANCHOR_ATTR]: "" }));
    const dsButton = dsAnchor.appendChild(new MockElement("button", { "aria-expanded": "false" }));

    // Mount delegated [data-rc-tip] and [data-tip] triggers
    const rcBtn = dom.body.appendChild(
      new MockElement("button", { "data-rc-tip": "Copy", "data-rc-tip-placement": "bottom" }),
    );
    const gwBtn = dom.body.appendChild(
      new MockElement("button", { "data-tip": "Reset to unlimited", "data-tip-placement": "right" }),
    );
    const emptySpace = dom.body.appendChild(new MockElement("div"));

    const dsBinding = bindTooltipTrigger({
      anchor: dsAnchor as unknown as HTMLElement,
      isDisabled: () => false,
      hasContent: () => true,
      getDelay: () => TOOLTIP_COLD_DELAY_MS,
      onOpen: (instant) => {
        dsState = { open: true, instant };
      },
      onClose: () => {
        dsState = { open: false, instant: false };
      },
    });
    const unbindRemote = bindDelegatedTooltips({
      doc: dom.doc as unknown as Document,
      onUpdate: (next) => {
        remoteBox.current = next;
      },
    });

    try {
      // A. Held mouse button (buttons !== 0, e.g. dragging slider or holding < / >) NEVER arms tooltips
      dsAnchor.dispatchOnSelf("pointerenter", { pointerType: "mouse", buttons: 1 });
      dom.doc.dispatch("pointerover", rcBtn, { pointerType: "mouse", buttons: 1 });
      clock.advance(600);
      expect(dsState.open).toBe(false);
      expect(remoteBox.current).toBeNull();

      // B. Touch pointer and html.mobile NEVER open hover tooltips
      dsAnchor.dispatchOnSelf("pointerenter", { pointerType: "touch", buttons: 0 });
      dom.doc.dispatch("pointerover", rcBtn, { pointerType: "touch", buttons: 0 });
      clock.advance(600);
      expect(dsState.open).toBe(false);
      expect(remoteBox.current).toBeNull();

      dom.documentElement.classList.add("mobile");
      dom.doc.dispatch("pointerover", rcBtn, { pointerType: "mouse", buttons: 0 });
      clock.advance(600);
      expect(remoteBox.current).toBeNull();
      dom.documentElement.classList.remove("mobile");

      // C. Cold hover on DS <Tooltip> opens at 500ms with instant = false
      dsAnchor.dispatchOnSelf("pointerenter", { pointerType: "mouse", buttons: 0 });
      clock.advance(499);
      expect(dsState.open).toBe(false);
      clock.advance(1);
      expect(dsState).toEqual({ open: true, instant: false });
      expect(remoteBox.current).toBeNull();

      // D. Warm rove from DS <Tooltip> -> delegated [data-rc-tip] opens in 0ms with instant = true & dismisses DS <Tooltip>!
      dsAnchor.dispatchOnSelf("pointerleave", { pointerType: "mouse" });
      expect(dsState.open).toBe(false);
      clock.advance(120);
      dom.doc.dispatch("pointerover", rcBtn, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      expect(dsState.open).toBe(false);
      expect(remoteBox.current).toEqual({
        target: rcBtn as unknown as HTMLElement,
        text: "Copy",
        placement: "bottom",
        instant: true,
      });

      // E. Live MutationObserver updates text reactively ("Copy" -> "Copied!") while open
      rcBtn.setAttribute("data-rc-tip", "Copied!");
      expect(remoteBox.current?.text).toBe("Copied!");

      // F. Warm rove from [data-rc-tip] -> [data-tip] -> back to DS <Tooltip> (without prior pointerout: mutual exclusion!)
      dom.doc.dispatch("pointerover", gwBtn, { pointerType: "mouse", buttons: 0, relatedTarget: rcBtn });
      expect(remoteBox.current).toEqual({
        target: gwBtn as unknown as HTMLElement,
        text: "Reset to unlimited",
        placement: "right",
        instant: true,
      });

      // Jump straight onto DS <Tooltip> even before pointerout fires on gwBtn -> gwBtn dismisses synchronously!
      dsAnchor.dispatchOnSelf("pointerenter", { pointerType: "mouse", buttons: 0 });
      expect(remoteBox.current).toBeNull();
      expect(dsState).toEqual({ open: true, instant: true });

      // G. Wheel / scroll / window blur immediately closes open tooltip and resets warm state
      dom.win.dispatch("wheel");
      expect(dsState.open).toBe(false);
      expect(sharedSession.isWarm()).toBe(false);

      // H. Programmatic focus (focusVisible = false, e.g. modal close button auto-focus) does NOT pop tooltip;
      //    keyboard :focus-visible DOES open cleanly and closes on focusout!
      gwBtn.focusVisible = false;
      dom.doc.dispatch("focusin", gwBtn);
      expect(remoteBox.current).toBeNull();

      gwBtn.focusVisible = true;
      dom.doc.dispatch("focusin", gwBtn);
      expect(remoteBox.current).toEqual({
        target: gwBtn as unknown as HTMLElement,
        text: "Reset to unlimited",
        placement: "right",
        instant: false,
      });
      dom.doc.dispatch("focusout", gwBtn, { relatedTarget: dsButton });
      expect(remoteBox.current).toBeNull();

      // Tabbing immediately to DS <Tooltip> button while warm opens with instant = true
      dsButton.focusVisible = true;
      dsAnchor.dispatchOnSelf("focusin", { target: dsButton });
      expect(dsState).toEqual({ open: true, instant: true });
      dsAnchor.dispatchOnSelf("focusout", { relatedTarget: emptySpace });
      expect(dsState.open).toBe(false);

      // I. MutationObserver immediately closes delegated tooltip when aria-expanded becomes "true" or node disconnects
      clock.advance(600); // expire warm state
      dom.doc.dispatch("pointerover", rcBtn, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Copied!");
      rcBtn.setAttribute("aria-expanded", "true");
      expect(remoteBox.current).toBeNull();
      expect(sharedSession.isWarm()).toBe(false);

      rcBtn.setAttribute("aria-expanded", "false");
      dom.doc.dispatch("pointerout", rcBtn, { relatedTarget: emptySpace });
      dom.doc.dispatch("pointerover", gwBtn, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.target).toBe(gwBtn as unknown as HTMLElement);
      gwBtn.remove(); // disconnect from DOM while open
      expect(remoteBox.current).toBeNull();
    } finally {
      dsBinding.cleanup();
      unbindRemote();
    }

    // All global listeners cleanly detached on unmount
    expect(dom.docListenerCount()).toBe(0);
    expect(dom.winListenerCount()).toBe(0);
  });

  test("DOM pointerdown stationary suppression (including icon swap), Escape/Enter/Space, scroll/blur/visibilitychange, and nested [data-rc-tip] roving", () => {
    const remoteBox: { current: DelegatedTooltipState | null } = { current: null };
    const outerRow = dom.body.appendChild(
      new MockElement("div", { "data-rc-tip": "Session row\n/workspace" }),
    );
    const innerPin = outerRow.appendChild(
      new MockElement("button", { "data-rc-tip": "Pin" }),
    );
    const oldSvg = innerPin.appendChild(new MockElement("svg"));
    const emptySpace = dom.body.appendChild(new MockElement("div"));

    const unbindRemote = bindDelegatedTooltips({
      doc: dom.doc as unknown as Document,
      onUpdate: (next) => {
        remoteBox.current = next;
      },
    });

    try {
      // 1. Nested roving: outerRow -> innerPin -> back to outerRow!
      dom.doc.dispatch("pointerover", outerRow, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Session row\n/workspace");
      expect(remoteBox.current?.instant).toBe(false);

      dom.doc.dispatch("pointerout", outerRow, { relatedTarget: innerPin });
      dom.doc.dispatch("pointerover", oldSvg, { pointerType: "mouse", buttons: 0, relatedTarget: outerRow });
      expect(remoteBox.current?.text).toBe("Pin");
      expect(remoteBox.current?.instant).toBe(true);

      // Moving back from innerPin onto outerRow re-opens outerRow instantly!
      dom.doc.dispatch("pointerout", innerPin, { relatedTarget: outerRow });
      dom.doc.dispatch("pointerover", outerRow, { pointerType: "mouse", buttons: 0, relatedTarget: innerPin });
      expect(remoteBox.current?.text).toBe("Session row\n/workspace");
      expect(remoteBox.current?.instant).toBe(true);

      // 2. Click (pointerdown) on innerPin + child SVG swap under stationary cursor does NOT re-pop!
      dom.doc.dispatch("pointerover", oldSvg, { pointerType: "mouse", buttons: 0, relatedTarget: outerRow });
      expect(remoteBox.current?.text).toBe("Pin");

      dom.doc.dispatch("pointerdown", oldSvg, { pointerType: "mouse", buttons: 1 });
      expect(remoteBox.current).toBeNull();
      expect(sharedSession.isWarm()).toBe(false);

      oldSvg.remove();
      const newSvg = innerPin.appendChild(new MockElement("svg"));
      dom.doc.dispatch("pointerover", newSvg, { pointerType: "mouse", buttons: 0, relatedTarget: null });
      clock.advance(1000);
      expect(remoteBox.current).toBeNull();

      // Leaving innerPin onto emptySpace clears suppression so re-hovering works again
      dom.doc.dispatch("pointerout", innerPin, { relatedTarget: emptySpace });
      dom.doc.dispatch("pointerover", newSvg, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Pin");

      // 3. Escape keydown dismisses immediately and resets warm state
      dom.doc.dispatch("keydown", innerPin, { key: "Escape" });
      expect(remoteBox.current).toBeNull();
      expect(sharedSession.isWarm()).toBe(false);

      // 4. Scroll capture, window blur, and visibilitychange dismiss immediately
      dom.doc.dispatch("pointerout", innerPin, { relatedTarget: emptySpace });
      dom.doc.dispatch("pointerover", outerRow, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Session row\n/workspace");
      dom.doc.dispatch("scroll", dom.body);
      expect(remoteBox.current).toBeNull();

      dom.doc.dispatch("pointerout", outerRow, { relatedTarget: emptySpace });
      dom.doc.dispatch("pointerover", outerRow, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Session row\n/workspace");
      dom.win.dispatch("blur");
      expect(remoteBox.current).toBeNull();

      dom.doc.dispatch("pointerout", outerRow, { relatedTarget: emptySpace });
      dom.doc.dispatch("pointerover", outerRow, { pointerType: "mouse", buttons: 0, relatedTarget: emptySpace });
      clock.advance(500);
      expect(remoteBox.current?.text).toBe("Session row\n/workspace");
      dom.doc.hidden = true;
      dom.doc.dispatch("visibilitychange", dom.body);
      expect(remoteBox.current).toBeNull();
    } finally {
      unbindRemote();
    }
  });

  test("singleton active-owner guard ensures only one RemoteHints instance is active when mounted in both index.tsx and IndirectCodePage.tsx", () => {
    expect(getActiveRemoteHintsCount()).toBe(0);

    let rootActive = false;
    let pageActive = false;
    let fixtureActive = false;

    const releaseRoot = claimRemoteHintsOwner((v) => {
      rootActive = v;
    });
    expect(rootActive).toBe(true);
    expect(getActiveRemoteHintsCount()).toBe(1);

    const releasePage = claimRemoteHintsOwner((v) => {
      pageActive = v;
    });
    const releaseFixture = claimRemoteHintsOwner((v) => {
      fixtureActive = v;
    });
    expect(rootActive).toBe(true);
    expect(pageActive).toBe(false);
    expect(fixtureActive).toBe(false);
    expect(getActiveRemoteHintsCount()).toBe(1);

    // Unmounting IndirectCodePage leaves root active seamlessly
    releasePage();
    expect(rootActive).toBe(true);
    expect(getActiveRemoteHintsCount()).toBe(1);

    // If active owner unmounts while standby remains, standby promotes cleanly
    releaseRoot();
    expect(rootActive).toBe(false);
    expect(fixtureActive).toBe(true);
    expect(getActiveRemoteHintsCount()).toBe(1);

    releaseFixture();
    expect(fixtureActive).toBe(false);
    expect(getActiveRemoteHintsCount()).toBe(0);
  });

  test("CSS, root shell mount, and component wiring contracts match specification", () => {
    const css = readFileSync(path.join(repoRoot, "web/src/ds/components.css"), "utf8");
    const indexSrc = readFileSync(path.join(repoRoot, "web/src/index.tsx"), "utf8");
    const presSrc = readFileSync(path.join(repoRoot, "web/src/indirect-code/presentation.tsx"), "utf8");

    expect(css).toContain(".ui-tooltip[data-instant] { opacity: 1; transform: none; transition: none; }");
    expect(indexSrc).toContain("<RemoteHints />");
    expect(indexSrc).not.toContain("delay={50}");
    expect(presSrc).not.toContain("anim-float-in");
    expect(presSrc).toContain("data-instant={instant() ? \"\" : undefined}");
  });
});
