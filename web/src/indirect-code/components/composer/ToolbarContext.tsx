import { batch, createEffect, createSignal, untrack, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { animate } from "../../../ds/motion/animate";
import { createGlide } from "../../../ds/motion/glide";
import { press } from "../../../ds/motion/press";
import { reducedMotion } from "../../../ds/motion/reduced";
import { motionTokens } from "../../../ds/motion/tokens";
import { attachSortable } from "../../../sortable";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";
import { MenuItem } from "../MenuItem";
import { formatEffort, normalizeEffort } from "../../utils/format";
import { baseMode, effectiveModeSkills, isModeSkillName as isModeSkill, originalUsable } from "../../utils/modeSkills";

/** The 4 mode skills form the single-choice primary selector. They render
 * from a temporary frontend cache until the daemon's official skill list
 * arrives; then the official list rules (description/mode taken from it,
 * entries that vanished or turned usable:"never" hidden). Exactly one is
 * mandatory as the primary skill (when any exists) and its mode becomes
 * the session mode the frontend sends. These never appear in the
 * additional skills list. */

export function ToolbarContext() {
  const c = useComposerCtx();
  const m = useModal();
  const s = useSession();
  const ui = useUI();

  // Mobile submenu navigation inside the "+" menu
  const [subView, setSubView] = createSignal<"main" | "effort" | "model" | "mode" | "access">("main");
  let subViewDir = 1;
  const switchSubView = (next: "main" | "effort" | "model" | "mode" | "access") => {
    const cur = subView();
    subViewDir = next === "main" || (cur === "model" && next === "effort") ? -1 : 1;
    setSubView(next);
  };
  const animateSubView = (el: HTMLElement) => {
    if (untrack(reducedMotion)) return;
    queueMicrotask(() => {
      if (!el.isConnected) return;
      animate(
        el,
        { opacity: 1, translate: "0px 0px", filter: "blur(0px)" },
        { duration: 0.22, ease: motionTokens.ease.enter },
        {
          from: {
            opacity: 0.2,
            translate: `${subViewDir * 14}px 0px`,
            filter: "blur(2.5px)",
          },
        },
      );
    });
  };

  // Local draft state while the Mode & Skills popup is open: avoids lag/stutter
  // by deferring network sync and session re-snapshots until "Done" or close.
  const [draftSkills, setDraftSkills] = createSignal<string[]>([]);
  const [draftUsables, setDraftUsables] = createSignal<Record<string, string>>({});
  const [draftAgentMode, setDraftAgentMode] = createSignal<string>("");
  const [isEditing, setIsEditing] = createSignal(false);

  const isMenuOpen = () => c.modeMenuOpen() || (c.addContextOpen() && subView() === "mode");
  const effectiveSelectedSkills = () => (isEditing() ? draftSkills() : c.selectedSkills());
  const effectiveSkillUsables = () => (isEditing() ? draftUsables() : (c.skillUsables?.() ?? {}));
  const effectiveAgentMode = () => (isEditing() ? draftAgentMode() : c.agentMode());

  const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const recordsEqual = (a: Record<string, string>, b: Record<string, string>) => {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[k] === b[k]);
  };

  /** The selection as it was when the popup OPENED (or when a mode pick
   * last committed it). applyDraft sends only the user's delta against it,
   * so changes that arrived from the daemon meanwhile — an AI use_skill
   * activation, a once skill expiring at turn end — are never undone by
   * closing the popup. */
  let openSnapshot: { skills: string[]; usables: Record<string, string>; mode: string } = { skills: [], usables: {}, mode: "" };

  createEffect(() => {
    const open = isMenuOpen();
    if (open) {
      untrack(() => {
        const skills = [...c.selectedSkills()];
        const usables = { ...(c.skillUsables?.() ?? {}) };
        setDraftSkills(skills);
        setDraftUsables(usables);
        setDraftAgentMode(c.agentMode());
        openSnapshot = { skills, usables, mode: c.agentMode() };
        setIsEditing(true);
      });
    } else if (isEditing()) {
      untrack(() => {
        applyDraft();
      });
    }
  });

  function applyDraft() {
    if (!isEditing()) return;
    const targetSkills = draftSkills();
    const targetUsables = draftUsables();
    const targetMode = draftAgentMode();
    const base = openSnapshot;

    const userChangedSkills = !arraysEqual(targetSkills, base.skills);
    const userChangedUsables = !recordsEqual(targetUsables, base.usables);
    const modeChanged = targetMode !== "" && targetMode !== base.mode;
    if (!userChangedSkills && !userChangedUsables && !modeChanged) {
      setIsEditing(false);
      return;
    }

    // Rebase the user's edit onto the live selection: keep the draft order
    // for what the user kept or added, drop what left the live selection
    // meanwhile (unless the user added it in the popup), and append what
    // arrived meanwhile that the user never saw.
    const current = c.selectedSkills();
    const opened = new Set(base.skills);
    const live = new Set(current);
    const kept = targetSkills.filter((n) => !opened.has(n) || live.has(n));
    const arrived = current.filter((n) => !opened.has(n) && !targetSkills.includes(n));
    const nextSkills = [...kept, ...arrived];

    // Usables: only the keys the user actually changed in the popup.
    const nextUsables = { ...(c.skillUsables?.() ?? {}) };
    for (const key of new Set([...Object.keys(targetUsables), ...Object.keys(base.usables)])) {
      if (targetUsables[key] !== base.usables[key]) {
        if (targetUsables[key] === undefined) delete nextUsables[key];
        else nextUsables[key] = targetUsables[key];
      }
    }

    batch(() => {
      setIsEditing(false);
      if (modeChanged) {
        c.setAgentMode(targetMode as any);
      }
      c.syncSkills?.(nextSkills, nextUsables);
    });
    c.configureSession();
  }

  // Reset to main view whenever the menu closes
  createEffect(() => {
    if (!c.addContextOpen()) {
      setSubView("main");
    }
  });

  /** The effective mode-skill list: cache before the official daemon list
   * loads, reconciled with it afterwards. For an EXISTING session the mode
   * is fixed at creation, so only skills of the session's own base mode
   * are offered (a talk session never shows build/plan/learning, an
   * agentic one never shows talk); drafts see the whole list. */
  function modeSkills() {
    const list = effectiveModeSkills(m.savedSkills?.() ?? {}, m.skillsLoaded?.() ?? false);
    if (s.draftMode()) return list;
    const base = baseMode(effectiveAgentMode());
    return list.filter((spec) => baseMode(spec.mode) === base);
  }

  /** The ASK/YOLO selector is hidden when the primary (lowest-priority)
   * skill has approvalMode "yolo" — derived here from the effective
   * catalog (the daemon-sent approvalMode of an existing session is the
   * fallback for skills the catalog no longer knows). */
  function approvalSelectorHidden() {
    const primary = effectiveSelectedSkills()[0];
    const saved = m.savedSkills?.() ?? {};
    const ap = primary
      ? saved[primary]?.approvalMode ?? modeSkills().find((s) => s.name === primary)?.approvalMode
      : undefined;
    return ap === "yolo" || c.approvalMode?.() === "yolo";
  }

  /** Chooses one of the mode skills as the session's primary skill: it goes
   * first in the active order (lowest priority number). */
  function chooseModeSkill(name: string) {
    const spec = modeSkills().find((s) => s.name === name);
    if (!spec) return;
    const mode = baseMode(spec.mode);
    const currentSkills = isEditing() ? draftSkills() : c.selectedSkills();
    const rest = currentSkills.filter((n) => n !== name && !isModeSkill(n));
    const nextSkills = [name, ...rest];
    const nextUsables = isEditing() ? draftUsables() : undefined;
    const alreadyCommitted =
      arraysEqual(c.selectedSkills(), nextSkills) &&
      c.agentMode() === mode &&
      (!nextUsables || recordsEqual(nextUsables, c.skillUsables?.() ?? {}));
    if (alreadyCommitted && (!isEditing() || (arraysEqual(draftSkills(), nextSkills) && draftAgentMode() === mode))) {
      return;
    }
    batch(() => {
      if (isEditing()) {
        setDraftAgentMode(mode);
        setDraftSkills(nextSkills);
        // The pick commits the whole draft right away: it becomes the new
        // base, so closing the popup only sends what changes after it.
        openSnapshot = { skills: [...nextSkills], usables: { ...draftUsables() }, mode };
      }
      c.setAgentMode(mode);
      c.syncSkills?.(nextSkills, nextUsables);
    });
    c.configureSession();
  }

  /** Additional skills = everything except the 4 mode skills. Displayed
   * order: selected (session priority order) first, then the rest by name. */
  function additionalSkills(): [string, any][] {
    const saved = m.savedSkills?.() ?? {};
    const sel = effectiveSelectedSkills().filter((n) => !isModeSkill(n));
    const rest = Object.entries(saved)
      .filter(([n, skill]) => !isModeSkill(n) && skill.enabled && originalUsable(skill.usable) !== "never")
      .map(([n]) => n)
      .filter((n) => !sel.includes(n))
      .sort();
    return [...sel, ...rest].map((n) => [n, saved[n]] as [string, any]);
  }

  /** Drag-to-sort of the additional list: active skills keep their order
   * under the primary (mode) skill; unusued rows are ignored. */
  function reorderAdditional(ids: string[]) {
    if (isEditing()) {
      const sel = draftSkills();
      const primary = sel.filter(isModeSkill);
      const rest = ids.filter((n) => sel.includes(n) && !isModeSkill(n));
      setDraftSkills([...primary, ...rest]);
    } else {
      const sel = c.selectedSkills();
      const primary = sel.filter(isModeSkill);
      const rest = ids.filter((n) => sel.includes(n) && !isModeSkill(n));
      c.syncSkills?.([...primary, ...rest]);
    }
  }

  function toggleAdditional(name: string) {
    if (isEditing()) {
      const sel = draftSkills();
      setDraftSkills(sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]);
    } else {
      const sel = c.selectedSkills();
      c.syncSkills?.(sel.includes(name) ? sel.filter((n) => n !== name) : [...sel, name]);
    }
  }

  /** Cycles a skill's session usable override within the locks of the
   * skill file's ORIGINAL: only an "ask" original may be pinned. The cycle
   * is ask → yolo → deny → ask, where "ask" (the original) is stored as
   * "inherit" — no override on the wire — so a session never round-trips
   * to a value the daemon would echo back differently. */
  function cycleSkillUsable(name: string, defaultUsable?: string) {
    if (originalUsable(defaultUsable) !== "ask") return;
    const order = ["ask", "yolo", "deny"];
    const idx = order.indexOf(shownUsable(name));
    const picked = order[(idx < 0 ? 0 : idx + 1) % order.length];
    const next = picked === "ask" ? "inherit" : picked;
    if (isEditing()) {
      setDraftUsables({ ...draftUsables(), [name]: next });
    } else {
      const map = { ...(c.skillUsables?.() ?? {}), [name]: next };
      c.syncSkills?.(c.selectedSkills(), map);
    }
  }

  /** The effective usable of an ask-original skill as the badge shows it:
   * no override ("inherit"/unset) is the original "ask". */
  function shownUsable(name: string): string {
    const v = effectiveSkillUsables()[name];
    return !v || v === "inherit" ? "ask" : v;
  }

  function activeModeSkillName(): string {
    const sel0 = effectiveSelectedSkills()[0];
    if (sel0 && isModeSkill(sel0)) return sel0;
    const base = baseMode(effectiveAgentMode());
    return modeSkills().find((m) => baseMode(m.mode) === base)?.name ?? (base === "talk" ? "talk" : "build");
  }

  function currentModeSpec() {
    const name = activeModeSkillName();
    return modeSkills().find((s) => s.name === name) || modeSkills()[0];
  }

  function additionalCount() {
    const saved = m.savedSkills?.() ?? {};
    return c.selectedSkills().filter((name) => !isModeSkill(name) && saved[name]?.enabled).length;
  }

  function activeAdditionalCount() {
    const saved = m.savedSkills?.() ?? {};
    return effectiveSelectedSkills().filter((name) => !isModeSkill(name) && saved[name]?.enabled).length;
  }

  const PostureSection = () => {
    const [postureTrack, setPostureTrack] = createSignal<HTMLDivElement>();
    const [postureInd, setPostureInd] = createSignal<HTMLSpanElement>();
    const [hoveredMode, setHoveredMode] = createSignal<string | null>(null);
    createGlide({
      container: postureTrack,
      indicator: postureInd,
      target: () => {
        void activeModeSkillName();
        void modeSkills().length;
        return postureTrack()?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ?? null;
      },
    });
    const captionSpec = () => {
      const h = hoveredMode();
      if (h) {
        const found = modeSkills().find((x) => x.name === h);
        if (found) return found;
      }
      return currentModeSpec();
    };
    return (
      <Show when={modeSkills().length > 0}>
        <div class="px-1.5 pt-1 pb-1.5">
          <div class="flex items-center justify-between px-1 pb-1.5">
            <span class="text-[11px] font-medium text-fg-muted">Execution posture</span>
          </div>
          <Show
            when={modeSkills().length > 1}
            fallback={
              <div role="menu" aria-label="Agent mode">
                <For each={modeSkills()}>
                  {(mode) => {
                    const active = () => activeModeSkillName() === mode.name;
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={active()}
                        onPointerDown={(e) => press(e.currentTarget)}
                        onClick={() => chooseModeSkill(mode.name)}
                        class="w-full flex items-center gap-2.5 rounded-lg border border-border bg-surface-subtle px-2.5 py-2 text-left transition-colors cursor-pointer"
                      >
                        <Iconify icon={mode.icon} size={14} class="text-accent shrink-0" />
                        <span class="flex-1 min-w-0">
                          <span class="flex items-center gap-1.5">
                            <span class="text-xs font-medium text-fg">{mode.label}</span>
                            <span class="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-px text-[10px] font-medium text-fg-muted">
                              <Iconify icon="lucide:lock" size={9} class="shrink-0" />
                              <span>Locked</span>
                            </span>
                          </span>
                          <span class="block text-[11px] text-fg-muted mt-0.5 leading-snug">{mode.description}</span>
                        </span>
                      </button>
                    );
                  }}
                </For>
              </div>
            }
          >
            <div
              ref={setPostureTrack}
              data-glide=""
              role="menu"
              aria-label="Agent mode"
              onPointerLeave={() => setHoveredMode(null)}
              class="ui-segmented relative flex w-full items-center p-0.5 gap-0.5"
            >
              <span ref={setPostureInd} class="ui-segmented-indicator" aria-hidden="true" />
              <For each={modeSkills()}>
                {(mode) => {
                  const active = () => activeModeSkillName() === mode.name;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active()}
                      onPointerEnter={() => setHoveredMode(mode.name)}
                      onFocus={() => setHoveredMode(mode.name)}
                      onBlur={() => setHoveredMode((cur) => (cur === mode.name ? null : cur))}
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => chooseModeSkill(mode.name)}
                      class={`ui-segment flex-auto px-2 py-1.5 text-xs font-medium flex items-center justify-center gap-1.5 rounded-md cursor-pointer transition-colors ${
                        active() ? "text-fg" : "text-fg-muted hover:text-fg-secondary"
                      }`}
                    >
                      <Iconify
                        icon={mode.icon}
                        size={13}
                        class={active() ? "text-accent shrink-0" : "text-fg-muted shrink-0"}
                      />
                      <span>{mode.label}</span>
                      <span class="sr-only"> — {mode.description}</span>
                    </button>
                  );
                }}
              </For>
            </div>
            <div class="mt-1.5 px-1 flex items-start gap-1.5 text-[11px] text-fg-muted min-h-[1rem]">
              <span class="mt-1.5 h-1 w-1 rounded-full bg-accent shrink-0" aria-hidden="true" />
              <span class="line-clamp-2 leading-snug">{captionSpec()?.description}</span>
            </div>
          </Show>
        </div>
      </Show>
    );
  };

  const additionalSkillList = () => (
    <>
      <div class="max-h-56 overflow-y-auto px-0.5 [scrollbar-gutter:stable]">
        <ul class="space-y-0.5" ref={(el) => attachSortable(el, { onReorder: reorderAdditional })}>
          <For each={additionalSkills()} fallback={<li class="px-2 py-2 text-xs text-fg-muted">No additional skills on this host.</li>}>
            {([name, skill]) => {
              const selected = () => effectiveSelectedSkills().includes(name);
              return (
                <li data-id={name} class="group/skill flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-muted/65 transition-colors">
                  <button
                    type="button"
                    data-handle
                    aria-label={`Reorder ${name}`}
                    data-rc-tip="Drag to reorder"
                    class={`shrink-0 p-1 rounded text-fg-muted hover:text-fg cursor-grab active:cursor-grabbing transition-opacity ${
                      ui.isMobile() ? "opacity-60" : "opacity-0 group-hover/skill:opacity-70 focus-visible:opacity-100"
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Iconify icon="lucide:grip-vertical" size={13} />
                  </button>
                  <div role="menu" aria-label={`Skill ${name}`} class="flex-1 flex min-w-0">
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={selected()}
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={() => toggleAdditional(name)}
                      class="flex-1 min-w-0 py-1 pr-1.5 flex items-center gap-2 text-left cursor-pointer"
                    >
                      <span
                        aria-hidden="true"
                        class={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors ${
                          selected()
                            ? "border-accent bg-accent text-accent-foreground"
                            : "border-border-strong bg-surface group-hover/skill:border-fg-muted"
                        }`}
                      >
                        <Show when={selected()}>
                          <Iconify icon="lucide:check" size={10} />
                        </Show>
                      </span>
                      <span class="flex-1 min-w-0">
                        <span class={`font-mono text-xs block truncate ${selected() ? "font-medium text-fg" : "text-fg-secondary"}`}>
                          {name}
                        </span>
                        <Show when={skill?.description}>
                          <span class="block text-[11px] text-fg-muted leading-tight truncate mt-0.5">
                            {skill?.description}
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>
                  <Show when={originalUsable(skill?.usable) === "ask"}>
                    <button
                      type="button"
                      aria-label={`Change activation policy for ${name}: ${shownUsable(name)}`}
                      data-rc-tip={`Activation policy: ${shownUsable(name)} (click to cycle)`}
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={(e) => { e.stopPropagation(); cycleSkillUsable(name, skill?.usable); }}
                      class={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none transition-colors cursor-pointer ${
                        shownUsable(name) === "yolo"
                          ? "border-warning/35 bg-warning-subtle text-warning hover:bg-warning/20"
                          : shownUsable(name) === "deny"
                          ? "border-danger/35 bg-danger-subtle text-danger hover:bg-danger/20"
                          : "border-border bg-surface-subtle text-fg-secondary hover:bg-surface-muted hover:text-fg"
                      }`}
                    >
                      {shownUsable(name)}
                    </button>
                  </Show>
                  <Show when={originalUsable(skill?.usable) === "yolo"}>
                    <span data-rc-tip="Always usable without asking" class="shrink-0 rounded-md border border-warning/25 bg-warning-subtle/60 px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-warning">yolo</span>
                  </Show>
                  <Show when={originalUsable(skill?.usable) === "deny"}>
                    <span data-rc-tip="Hidden from model auto-activation" class="shrink-0 rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-[10px] font-medium leading-none text-fg-muted">hidden</span>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </div>
      <Show when={(m.skillErrors?.() ?? []).length > 0}>
        <div role="status" class="mx-1 mt-1.5 rounded-lg border border-warning/35 bg-warning-subtle px-2.5 py-2 text-[11px] text-warning">
          <div class="flex items-center gap-1.5 font-medium">
            <Iconify icon="lucide:circle-alert" size={12} />
            <span>{(m.skillErrors?.() ?? []).length === 1 ? "1 skill file failed to load" : `${(m.skillErrors?.() ?? []).length} skill files failed to load`}</span>
          </div>
          <ul class="mt-1 space-y-0.5 text-fg-secondary font-mono text-[10px]">
            <For each={m.skillErrors?.() ?? []}>{(err) => <li class="break-words">{err}</li>}</For>
          </ul>
        </div>
      </Show>
    </>
  );

  const permissionsList = (closeOnPick: boolean) => (
    <div role="menu" aria-label="Agent permissions" class="space-y-1 px-0.5 pb-0.5">
      <For
        each={[
          { full: false, label: "Ask for approval", description: "Ask before every tool call, including reads and commands.", icon: "lucide:hand" },
          { full: true, label: "Full access", description: "Allow all tool calls without asking (YOLO).", icon: "lucide:shield-alert" },
        ]}
      >
        {(access) => {
          const active = () => c.yoloMode() === access.full;
          return (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={active()}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => {
                if (c.yoloMode() !== access.full) {
                  c.setYoloMode(access.full);
                  c.configureSession();
                }
                if (closeOnPick) c.setAccessMenuOpen(false);
              }}
              class={`w-full flex items-start gap-2.5 px-2.5 py-2 text-left rounded-lg border transition-colors cursor-pointer ${
                active()
                  ? access.full
                    ? "border-warning/30 bg-warning-subtle text-warning hover:bg-warning/20"
                    : "border-border bg-surface-subtle text-fg"
                  : access.full
                  ? "border-transparent hover:bg-warning-subtle/50 text-fg-secondary"
                  : "border-transparent hover:bg-surface-muted text-fg-secondary"
              }`}
            >
              <Iconify
                icon={access.icon}
                size={15}
                class={`mt-0.5 shrink-0 ${access.full ? "text-warning" : active() ? "text-accent" : "text-fg-muted"}`}
              />
              <span class="flex-1 min-w-0">
                <span class={`block text-xs font-medium ${access.full ? "text-warning" : "text-fg"}`}>{access.label}</span>
                <span class={`block mt-0.5 text-[11px] leading-snug ${access.full && active() ? "text-warning/85" : "text-fg-muted"}`}>
                  {access.description}
                </span>
              </span>
              <span class="w-4 mt-0.5 flex items-center justify-end shrink-0">
                <Show when={active()}>
                  <Iconify icon="lucide:check" size={13} class={access.full ? "text-warning shrink-0" : "text-accent shrink-0"} />
                </Show>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );

  return (
<>
<div>
  <button
    type="button"
    ref={c.addBtn}
    data-menubtn
    aria-expanded={c.addContextOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={(e) => {
      e.stopPropagation();
      const next = !c.addContextOpen();
      ui.closeMenus();
      ui.setEffortMenuOpen?.(false);
      ui.setModelMenuOpen(false);
      c.setAddContextOpen(next);
    }}
    class="rc-composer-add w-7 h-7 rounded-full text-fg-secondary hover:text-fg hover:bg-surface-muted flex items-center justify-center cursor-pointer transition-colors"
    data-rc-tip={ui.isMobile() ? "Add & Settings" : "Add context"}
    aria-label={ui.isMobile() ? "Add & Settings" : "Add context"}
  >
    <Iconify icon="lucide:plus" size={15} />
  </button>
  <FloatMenu
    anchor={() => c.addBtn}
    open={c.addContextOpen()}
    onClose={() => c.setAddContextOpen(false)}
    role="dialog"
    aria-label={ui.isMobile() ? "Add & Settings" : "Add context"}
    placement="top-start"
    width={
      ui.isMobile()
        ? subView() === "model" || subView() === "mode"
          ? "min(24rem, calc(100vw - 1rem))"
          : subView() === "effort" || subView() === "access"
          ? "min(21rem, calc(100vw - 1rem))"
          : "min(17rem, calc(100vw - 1.25rem))"
        : "13rem"
    }
  >
    <Show
      when={ui.isMobile()}
      fallback={
        /* Desktop: original "Add context" menu */
        <>
          <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">
            Add context
          </div>
          <MenuItem
            icon="lucide:paperclip"
            onClick={() => {
              c.setAddContextOpen(false);
              document.querySelector<HTMLInputElement>("#rc-file-input")?.click();
            }}
          >
            <span>Attach files</span>
          </MenuItem>
          <MenuItem
            icon="lucide:at-sign"
            onClick={() => {
              c.setAddContextOpen(false);
              c.mentions.begin();
              try {
                document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
              } catch {}
            }}
          >
            <span>Mentions</span>
          </MenuItem>
          <MenuItem
            icon="lucide:slash"
            onClick={() => {
              c.setAddContextOpen(false);
              c.setInputPrompt("/");
              try {
                document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
              } catch {}
            }}
          >
            <span>Actions</span>
          </MenuItem>
        </>
      }
    >
      {/* Mobile views: Root menu + Subviews */}
      <Show when={subView() === "main"}>
        <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">
          Add context
        </div>
        <MenuItem
          icon="lucide:paperclip"
          onClick={() => {
            c.setAddContextOpen(false);
            document.querySelector<HTMLInputElement>("#rc-file-input")?.click();
          }}
        >
          <span>Attach files</span>
        </MenuItem>
        <MenuItem
          icon="lucide:at-sign"
          onClick={() => {
            c.setAddContextOpen(false);
            c.mentions.begin();
            try {
              document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
            } catch {}
          }}
        >
          <span>Mentions</span>
        </MenuItem>
        <MenuItem
          icon="lucide:slash"
          onClick={() => {
            c.setAddContextOpen(false);
            c.setInputPrompt("/");
            try {
              document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
            } catch {}
          }}
        >
          <span>Actions</span>
        </MenuItem>

        <div class="mt-1 border-t border-border/70 pt-1">
          <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">
            Configuration
          </div>
          <MenuItem
            icon="lucide:cpu"
            onClick={() => switchSubView("effort")}
          >
            <span class="flex-1 truncate text-fg font-medium text-xs">
              {c.activeModelName()}
            </span>
            <Show when={formatEffort(c.effort())}>
              <span
                class={`shrink-0 font-mono text-[10px] ml-1 ${
                  normalizeEffort(c.effort()) === "max"
                    ? "text-accent font-medium"
                    : "text-fg-muted"
                }`}
              >
                {formatEffort(c.effort())}
              </span>
            </Show>
            <Iconify icon="lucide:chevron-right" size={13} class="text-fg-muted shrink-0 ml-1" />
          </MenuItem>

          <MenuItem
            icon={currentModeSpec()?.icon ?? (c.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer")}
            onClick={() => switchSubView("mode")}
          >
            <span class="flex-1">Mode</span>
            <span class="text-fg-secondary font-medium text-[11px] capitalize">
              {currentModeSpec()?.label ?? c.agentMode()}
              <Show when={additionalCount() > 0}>
                <span class="text-accent"> (+{additionalCount()})</span>
              </Show>
            </span>
            <Iconify icon="lucide:chevron-right" size={13} class="text-fg-muted shrink-0 ml-1" />
          </MenuItem>

          <Show when={!approvalSelectorHidden()}>
          <MenuItem
            icon={c.yoloMode() ? "lucide:shield-alert" : "lucide:hand"}
            iconClass={c.yoloMode() ? "text-warning" : "text-fg-muted"}
            onClick={() => switchSubView("access")}
          >
            <span class="flex-1">Permissions</span>
            <span class={`inline-flex items-center text-[11px] font-medium ${c.yoloMode() ? "text-warning" : "text-fg-secondary"}`}>
              <span>{c.yoloMode() ? "Full" : "Ask"}</span>
            </span>
            <Iconify icon="lucide:chevron-right" size={13} class="text-fg-muted shrink-0 ml-1" />
          </MenuItem>
          </Show>
        </div>
      </Show>

      <Show when={subView() === "effort"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1.5 py-1 border-b border-border-subtle">
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg flex items-center gap-1 text-xs cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-fg">Effort</span>
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => c.setAddContextOpen(false)}
              class="px-2 py-0.5 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg text-xs font-medium cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
          <div>{c.effortPickerBody(() => switchSubView("model"))}</div>
        </div>
      </Show>

      <Show when={subView() === "model"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1.5 py-1 border-b border-border-subtle">
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("effort")}
              class="px-1.5 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg flex items-center gap-1 text-xs cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-fg">Select model</span>
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => c.setAddContextOpen(false)}
              class="px-2 py-0.5 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg text-xs font-medium cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
          <div>{c.modelPickerBody(false)}</div>
        </div>
      </Show>

      <Show when={subView() === "mode"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1.5 py-1 mb-0.5 border-b border-border-subtle">
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg flex items-center gap-1 text-xs cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-fg">Mode & Skills</span>
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => {
                applyDraft();
                c.setAddContextOpen(false);
              }}
              class="px-2 py-0.5 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg font-medium text-xs cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
          <PostureSection />
          <div class={`${modeSkills().length > 0 ? "mt-1 border-t border-border-subtle pt-1.5" : "pt-1"}`}>
            <div class="flex items-center justify-between px-2.5 pb-1">
              <span class="text-[11px] font-medium text-fg-muted">Skill matrix</span>
              <Show when={additionalSkills().length > 0}>
                <span class="font-mono text-[10px] text-fg-muted tabular-nums">
                  {activeAdditionalCount()}/{additionalSkills().length} active
                </span>
              </Show>
            </div>
            {additionalSkillList()}
          </div>
        </div>
      </Show>

      <Show when={subView() === "access"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1.5 py-1 mb-1 border-b border-border-subtle">
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg flex items-center gap-1 text-xs cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-fg">Permissions</span>
            <button
              type="button"
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => c.setAddContextOpen(false)}
              class="px-2 py-0.5 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg text-xs font-medium cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
          <p class="px-2.5 py-1 text-[11px] font-medium text-fg-muted">Execution permissions</p>
          {permissionsList(false)}
        </div>
      </Show>

    </Show>
  </FloatMenu>
</div>

{/* Desktop only: Mode and Permissions in the toolbar */}
<Show when={!ui.isMobile()}>
<div>
  <button type="button" ref={c.modeBtn} data-menubtn data-rc-tip="Mode & skills" aria-label={`Agent mode and skills: ${currentModeSpec()?.label ?? c.agentMode()}${additionalCount() > 0 ? ` +${additionalCount()}` : ""}`} aria-expanded={c.modeMenuOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={() => { const next = !c.modeMenuOpen(); ui.closeMenus(); c.setModeMenuOpen(next); }}
    class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer">
    <Iconify icon={currentModeSpec()?.icon ?? (c.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer")} size={13} class="text-accent shrink-0" />
    <span class="capitalize">{currentModeSpec()?.label ?? c.agentMode()}<Show when={additionalCount() > 0}><span class="font-mono text-[11px] text-accent">{` +${additionalCount()}`}</span></Show></span>
    <Iconify icon="lucide:chevron-down" size={11} class={`text-fg-muted transition-transform duration-150 ${c.modeMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu anchor={() => c.modeBtn} open={c.modeMenuOpen()} onClose={() => c.setModeMenuOpen(false)} role="dialog" aria-label="Mode & Skills" placement="top-start" width="min(24.5rem, calc(100vw - 1.5rem))">
    <div class="flex items-center justify-between px-2.5 py-1 border-b border-border-subtle mb-0.5">
      <span class="font-medium text-xs text-fg">Mode & Skills</span>
      <button
        type="button"
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={() => {
          applyDraft();
          c.setModeMenuOpen(false);
        }}
        class="px-2 py-0.5 rounded-md hover:bg-surface-muted text-fg-secondary hover:text-fg font-medium text-xs cursor-pointer transition-colors"
      >
        Done
      </button>
    </div>
    <PostureSection />
    <div class={`${modeSkills().length > 0 ? "mt-1 border-t border-border-subtle pt-1.5" : "pt-1"}`}>
      <div class="flex items-center justify-between px-2.5 pb-1">
        <span class="text-[11px] font-medium text-fg-muted">Skill matrix</span>
        <Show when={additionalSkills().length > 0}>
          <span class="font-mono text-[10px] text-fg-muted tabular-nums">
            {activeAdditionalCount()}/{additionalSkills().length} active
          </span>
        </Show>
      </div>
      {additionalSkillList()}
    </div>
  </FloatMenu>
</div>
<Show when={!approvalSelectorHidden()}>
<div>
  <button type="button" ref={c.accessBtn} data-menubtn data-rc-tip={c.yoloMode() ? "Permissions: Full access" : "Permissions: Ask for approval"} aria-label={`Agent permissions: ${c.yoloMode() ? "Full access" : "Ask for approval"}`} aria-expanded={c.accessMenuOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={() => { const next = !c.accessMenuOpen(); ui.closeMenus(); c.setAccessMenuOpen(next); }}
    class={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium cursor-pointer transition-colors hover:bg-surface-muted ${c.yoloMode() ? "text-warning" : "text-fg-secondary hover:text-fg"}`}>
    <Iconify icon={c.yoloMode() ? "lucide:shield-alert" : "lucide:hand"} size={13} class={c.yoloMode() ? "text-warning shrink-0" : "text-fg-muted shrink-0"} />
    <span class="hidden sm:inline">{c.yoloMode() ? "Full" : "Ask"}</span>
  </button>
  <FloatMenu anchor={() => c.accessBtn} open={c.accessMenuOpen()} onClose={() => c.setAccessMenuOpen(false)} placement="top-start" width="min(21rem, calc(100vw - 1.5rem))">
    <p class="px-2.5 py-1 text-[11px] font-medium text-fg-muted border-b border-border-subtle mb-1">Execution permissions</p>
    {permissionsList(true)}
  </FloatMenu>
</div>
</Show>
</Show>
</>
  );
}
