import { createEffect, createSignal, untrack, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { animate } from "../../../ds/motion/animate";
import { press } from "../../../ds/motion/press";
import { reducedMotion } from "../../../ds/motion/reduced";
import { motionTokens } from "../../../ds/motion/tokens";
import { attachSortable } from "../../../sortable";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { FloatMenu } from "../FloatMenu";
import { MenuItem } from "../MenuItem";
import { formatEffort } from "../../utils/format";
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
  const [subView, setSubView] = createSignal<"main" | "model" | "mode" | "access">("main");
  let subViewDir = 1;
  const switchSubView = (next: "main" | "model" | "mode" | "access") => {
    subViewDir = next === "main" ? -1 : 1;
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
  const [optimisticModeSkill, setOptimisticModeSkill] = createSignal<string | null>(null);

  createEffect(() => {
    s.activeSessionId();
    setOptimisticModeSkill(null);
  });

  createEffect(() => {
    const opt = optimisticModeSkill();
    if (!opt) return;
    if (c.selectedSkills()[0] === opt) {
      setOptimisticModeSkill(null);
    }
  });

  const isMenuOpen = () => c.modeMenuOpen() || (c.addContextOpen() && subView() === "mode");
  const effectiveSelectedSkills = () => {
    if (isEditing()) return draftSkills();
    const opt = optimisticModeSkill();
    if (opt) {
      const rest = c.selectedSkills().filter((n) => n !== opt && !isModeSkill(n));
      return [opt, ...rest];
    }
    return c.selectedSkills();
  };
  const effectiveSkillUsables = () => (isEditing() ? draftUsables() : (c.skillUsables?.() ?? {}));
  const effectiveAgentMode = () => {
    if (isEditing()) return draftAgentMode();
    const opt = optimisticModeSkill();
    if (opt) {
      // Look the optimistic pick up in the UNFILTERED catalog: modeSkills()
      // filters by this very function, so asking it here recursed until the
      // stack blew up as soon as a mode pick was pending.
      const spec = effectiveModeSkills(m.savedSkills?.() ?? {}, m.skillsLoaded?.() ?? false).find((x) => x.name === opt);
      if (spec) return baseMode(spec.mode);
    }
    return c.agentMode();
  };

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
    setIsEditing(false);
    const targetSkills = draftSkills();
    const targetUsables = draftUsables();
    const targetMode = draftAgentMode();
    const base = openSnapshot;

    const userChangedSkills = !arraysEqual(targetSkills, base.skills);
    const userChangedUsables = !recordsEqual(targetUsables, base.usables);
    const modeChanged = targetMode !== "" && targetMode !== base.mode;
    if (!userChangedSkills && !userChangedUsables && !modeChanged) return;

    const primaryMode = targetSkills.find(isModeSkill);
    if (primaryMode) {
      setOptimisticModeSkill(primaryMode);
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

    if (modeChanged) {
      c.setAgentMode(targetMode as any);
    }
    c.syncSkills?.(nextSkills, nextUsables);
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
    const rest = (isEditing() ? draftSkills() : c.selectedSkills()).filter((n) => n !== name && !isModeSkill(n));
    const nextSkills = [name, ...rest];
    setOptimisticModeSkill(name);
    if (isEditing()) {
      setDraftAgentMode(mode);
      setDraftSkills(nextSkills);
      // The pick commits the whole draft right away: it becomes the new
      // base, so closing the popup only sends what changes after it.
      openSnapshot = { skills: [...nextSkills], usables: { ...draftUsables() }, mode };
    }
    c.setAgentMode(mode);
    c.syncSkills?.(nextSkills, isEditing() ? draftUsables() : undefined);
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

  const modeSkillList = () => (
    <div role="menu" aria-label="Agent mode" class="bg-card">
      <For each={modeSkills()}>
        {(mode) => (
          <button
            role="menuitemradio"
            aria-checked={activeModeSkillName() === mode.name}
            onPointerDown={(e) => press(e.currentTarget)}
            onClick={() => chooseModeSkill(mode.name)}
            class={`w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors cursor-pointer ${
              activeModeSkillName() === mode.name ? "bg-elev/80" : "hover:bg-elev"
            }`}
          >
            <Iconify icon={mode.icon} size={16} />
            <span class="flex-1">
              <span class="font-medium text-ink-100">{mode.label}</span>
              <span class="block text-[11px] text-ink-500 mt-0.5">{mode.description}</span>
            </span>
            <Show when={activeModeSkillName() === mode.name}>
              <Iconify icon="lucide:check" size={14} />
            </Show>
          </button>
        )}
      </For>
    </div>
  );

  const additionalSkillList = () => (
    <>
      <ul ref={(el) => attachSortable(el, { onReorder: reorderAdditional })}>
        <For each={additionalSkills()} fallback={<li class="p-2 text-ink-500">No additional skills on this host.</li>}>
          {([name, skill]) => (
            <li data-id={name} class="flex items-center gap-1">
              <button data-handle aria-label={`Reorder ${name}`} class="shrink-0 px-1 py-2 text-ink-600 hover:text-ink-300 cursor-grab" onClick={(e) => e.stopPropagation()}>
                <Iconify icon="lucide:grip-vertical" size={14} />
              </button>
              <div role="menu" aria-label={`Skill ${name}`} class="flex-1 flex bg-card">
                <button
                  role="menuitemcheckbox"
                  aria-checked={effectiveSelectedSkills().includes(name)}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => toggleAdditional(name)}
                  class="flex-1 rounded-lg px-2 py-2 flex items-center gap-2 text-left hover:bg-elev transition-colors cursor-pointer"
                >
                  <Iconify icon="lucide:puzzle" size={14} />
                  <span class="flex-1">
                    <span class="text-ink-200">{name}</span>
                    <span class="block text-[11px] text-ink-500">{skill?.description}</span>
                  </span>
                  <Show when={effectiveSelectedSkills().includes(name)}>
                    <Iconify icon="lucide:check" size={14} />
                  </Show>
                </button>
              </div>
              <Show when={originalUsable(skill?.usable) === "ask"}>
                <button
                  aria-label={`Change activation policy for ${name}: ${shownUsable(name)}`}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={(e) => { e.stopPropagation(); cycleSkillUsable(name, skill?.usable); }}
                  class="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-300 hover:bg-elev transition-colors cursor-pointer"
                >
                  {shownUsable(name)}
                </button>
              </Show>
              <Show when={originalUsable(skill?.usable) === "yolo"}>
                <span class="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-500">yolo</span>
              </Show>
              <Show when={originalUsable(skill?.usable) === "deny"}>
                <span class="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-500">hidden</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={(m.skillErrors?.() ?? []).length > 0}>
        <div role="status" class="mx-1 mt-1 rounded-lg border border-warning/35 bg-warning-subtle px-2 py-1.5 text-[11px] text-warning">
          <div class="flex items-center gap-1 font-medium">
            <Iconify icon="lucide:circle-alert" size={12} />
            <span>{(m.skillErrors?.() ?? []).length === 1 ? "1 skill file failed to load" : `${(m.skillErrors?.() ?? []).length} skill files failed to load`}</span>
          </div>
          <ul class="mt-1 space-y-0.5 text-fg-secondary">
            <For each={m.skillErrors?.() ?? []}>{(err) => <li class="break-words">{err}</li>}</For>
          </ul>
        </div>
      </Show>
    </>
  );

  return (
<>
<div>
  <button
    ref={c.addBtn}
    data-menubtn
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={(e) => {
      e.stopPropagation();
      c.setAddContextOpen(!c.addContextOpen());
      ui.setModelMenuOpen(false);
    }}
    class="rc-composer-add w-6 h-6 rounded-full hover:bg-ink-800 flex items-center justify-center cursor-pointer transition-colors"
    data-rc-tip={ui.isMobile() ? "Add & Settings" : "Add context"}
    aria-label={ui.isMobile() ? "Add & Settings" : "Add context"}
  >
    <Iconify icon="lucide:plus" size={14} />
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
        ? subView() === "model"
          ? "22rem"
          : subView() === "mode" || subView() === "access"
          ? "20rem"
          : "16rem"
        : "12rem"
    }
  >
    <Show
      when={ui.isMobile()}
      fallback={
        /* Desktop: original "Add context" menu */
        <>
          <div class="px-2 py-1 text-[11px] font-medium text-fg-muted">
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
        <div class="px-2 py-1 text-[11px] font-medium text-fg-muted">
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

        <div class="mt-1 border-t border-line/60 pt-1">
          <div class="px-2 py-1 text-[11px] font-medium text-fg-muted">
            Configuration
          </div>
          <MenuItem
            icon="lucide:cpu"
            onClick={() => switchSubView("model")}
          >
            <span class="flex-1 truncate text-ink-100 font-medium text-xs">
              {c.activeModelName()}
            </span>
            <Show when={formatEffort(c.effort())}>
              <span class="text-ink-500 shrink-0 text-[10px] ml-1">
                {formatEffort(c.effort())}
              </span>
            </Show>
            <Iconify icon="lucide:chevron-right" size={13} class="text-ink-500 shrink-0 ml-1" />
          </MenuItem>

          <MenuItem
            icon={currentModeSpec()?.icon ?? (c.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer")}
            onClick={() => switchSubView("mode")}
          >
            <span class="flex-1">Mode</span>
            <span class="text-ink-300 font-medium text-[11px] capitalize">
              {currentModeSpec()?.label ?? c.agentMode()}
              <Show when={additionalCount() > 0}>
                <span class="text-ink-500"> (+{additionalCount()})</span>
              </Show>
            </span>
            <Iconify icon="lucide:chevron-right" size={13} class="text-ink-500 shrink-0 ml-1" />
          </MenuItem>

          <Show when={!approvalSelectorHidden()}>
          <MenuItem
            icon={c.yoloMode() ? "lucide:shield-alert" : "lucide:hand"}
            iconClass={c.yoloMode() ? "text-danger" : ""}
            onClick={() => switchSubView("access")}
          >
            <span class="flex-1">Permissions</span>
            <span class={`text-[11px] font-medium ${c.yoloMode() ? "text-danger" : "text-ink-300"}`}>
              {c.yoloMode() ? "Full access" : "Ask for approval"}
            </span>
            <Iconify icon="lucide:chevron-right" size={13} class="text-ink-500 shrink-0 ml-1" />
          </MenuItem>
          </Show>
        </div>
      </Show>

      <Show when={subView() === "model"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1 py-1 mb-1 border-b border-line/60">
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-ink-800 text-ink-400 hover:text-ink-100 flex items-center gap-1 text-xs cursor-pointer"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-ink-200">Select model</span>
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => c.setAddContextOpen(false)}
              class="px-1.5 py-1 rounded-md hover:bg-ink-800 text-ink-400 hover:text-ink-100 text-xs cursor-pointer"
            >
              Done
            </button>
          </div>
          <div>{c.modelPickerBody()}</div>
        </div>
      </Show>

      <Show when={subView() === "mode"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1 py-1 mb-1 border-b border-line/60">
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-ink-800 text-ink-400 hover:text-ink-100 flex items-center gap-1 text-xs cursor-pointer"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-ink-200">Agent mode</span>
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => {
                applyDraft();
                c.setAddContextOpen(false);
              }}
              class="px-2 py-0.5 rounded-md bg-accent hover:bg-accent-hover text-accent-foreground font-medium text-xs cursor-pointer transition-colors"
            >
              Done
            </button>
          </div>
          <Show when={modeSkills().length > 0}>
            <p class="px-2 py-1.5 font-medium text-ink-400">Mode</p>
            {modeSkillList()}
          </Show>
          <div class="mt-1 border-t border-line pt-2">
            <p class="px-2 pb-1 font-medium text-ink-400">Additional skills</p>
            {additionalSkillList()}
          </div>
        </div>
      </Show>

      <Show when={subView() === "access"}>
        <div ref={animateSubView}>
          <div class="flex items-center justify-between px-1 py-1 mb-1 border-b border-line/60">
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => switchSubView("main")}
              class="px-1.5 py-1 rounded-md hover:bg-ink-800 text-ink-400 hover:text-ink-100 flex items-center gap-1 text-xs cursor-pointer"
            >
              <Iconify icon="lucide:chevron-left" size={14} />
              <span>Back</span>
            </button>
            <span class="font-medium text-xs text-ink-200">Permissions</span>
            <button
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => c.setAddContextOpen(false)}
              class="px-1.5 py-1 rounded-md hover:bg-ink-800 text-ink-400 hover:text-ink-100 text-xs cursor-pointer"
            >
              Done
            </button>
          </div>
          <p class="px-2 py-2 text-ink-400">How should actions be approved?</p>
          <div role="menu" aria-label="Agent permissions" class="bg-card">
          <For
            each={[
              { full: false, label: "Ask for approval", description: "Ask before every tool call, including reads and commands.", icon: "lucide:hand" },
              { full: true, label: "Full access", description: "Allow all tool calls without asking (YOLO).", icon: "lucide:shield-alert" },
            ]}
          >
            {(access) => (
              <button
                role="menuitemradio"
                aria-checked={c.yoloMode() === access.full}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => {
                  c.setYoloMode(access.full);
                  c.configureSession();
                }}
                class="w-full flex items-center gap-3 px-2 py-3 text-left rounded-lg hover:bg-elev cursor-pointer transition-colors"
              >
                <Iconify icon={access.icon} size={19} class={access.full ? "text-danger" : ""} />
                <span class="flex-1">
                  <span class={`font-medium ${access.full ? "text-danger" : "text-ink-100"}`}>
                    {access.label}
                  </span>
                  <span class={`block mt-1 text-[11px] ${access.full ? "text-danger/80" : "text-ink-500"}`}>
                    {access.description}
                  </span>
                </span>
                <Show when={c.yoloMode() === access.full}>
                  <Iconify icon="lucide:check" size={14} class={access.full ? "text-danger" : ""} />
                </Show>
              </button>
            )}
          </For>
          </div>
        </div>
      </Show>

    </Show>
  </FloatMenu>
</div>

{/* Desktop only: Mode and Permissions in the toolbar */}
<Show when={!ui.isMobile()}>
<div>
  <button ref={c.modeBtn} data-menubtn aria-label={`Agent mode and skills: ${currentModeSpec()?.label ?? c.agentMode()}${additionalCount() > 0 ? ` +${additionalCount()}` : ""}`} aria-expanded={c.modeMenuOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={() => { const next = !c.modeMenuOpen(); ui.closeMenus(); c.setModeMenuOpen(next); }}
    class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-elev transition-colors cursor-pointer">
    <Iconify icon={currentModeSpec()?.icon ?? (c.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer")} size={14} />
    <span class="capitalize">{currentModeSpec()?.label ?? c.agentMode()}<Show when={additionalCount() > 0}><span class="text-ink-500">{` +${additionalCount()}`}</span></Show></span>
    <Iconify icon="lucide:chevron-down" size={11} class={`transition-transform duration-150 ${c.modeMenuOpen() ? "rotate-180" : ""}`} />
  </button>
  <FloatMenu anchor={() => c.modeBtn} open={c.modeMenuOpen()} onClose={() => c.setModeMenuOpen(false)} role="dialog" aria-label="Mode & Skills" placement="top-start" width="20rem">
    <div class="flex items-center justify-between px-2 py-1.5 border-b border-line/60 mb-1">
      <span class="font-medium text-xs text-ink-200">Mode & Skills</span>
      <button
        onPointerDown={(e) => press(e.currentTarget)}
        onClick={() => {
          applyDraft();
          c.setModeMenuOpen(false);
        }}
        class="px-2.5 py-0.5 rounded-md bg-accent hover:bg-accent-hover text-accent-foreground font-medium text-xs cursor-pointer transition-colors"
      >
        Done
      </button>
    </div>
    <Show when={modeSkills().length > 0}>
      <p class="px-2 py-1.5 font-medium text-ink-400">Mode</p>
      {modeSkillList()}
    </Show>
    <div class="mt-1 border-t border-line pt-2"><p class="px-2 pb-1 font-medium text-ink-400">Additional skills</p>
      {additionalSkillList()}
    </div>
  </FloatMenu>
</div>
<Show when={!approvalSelectorHidden()}>
<div>
  <button ref={c.accessBtn} data-menubtn aria-label={`Agent permissions: ${c.yoloMode() ? "Full access" : "Ask for approval"}`} aria-expanded={c.accessMenuOpen()}
    onPointerDown={(e) => press(e.currentTarget)}
    onClick={() => { const next = !c.accessMenuOpen(); ui.closeMenus(); c.setAccessMenuOpen(next); }}
    class={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs hover:bg-elev cursor-pointer transition-colors ${
      c.yoloMode() ? "text-danger" : ""
    }`}>
    <Iconify icon={c.yoloMode() ? "lucide:shield-alert" : "lucide:hand"} size={14} class={c.yoloMode() ? "text-danger" : ""} /><span class={`hidden sm:inline ${c.yoloMode() ? "text-danger" : ""}`}>{c.yoloMode() ? "Full access" : "Ask for approval"}</span>
  </button>
  <FloatMenu anchor={() => c.accessBtn} open={c.accessMenuOpen()} onClose={() => c.setAccessMenuOpen(false)} placement="top-start" width="22rem">
    <p class="px-2 py-2 text-ink-400">How should actions be approved?</p>
    <div role="menu" aria-label="Agent permissions" class="bg-card">
    <For each={[{full:false, label:"Ask for approval", description:"Ask before every tool call, including reads and commands.", icon:"lucide:hand"}, {full:true, label:"Full access", description:"Allow all tool calls without asking (YOLO).", icon:"lucide:shield-alert"}]}>{(access) =>
      <button role="menuitemradio" aria-checked={c.yoloMode() === access.full} onPointerDown={(e) => press(e.currentTarget)} onClick={() => { c.setYoloMode(access.full); c.configureSession(); c.setAccessMenuOpen(false); }} class="w-full flex items-center gap-3 px-2 py-3 text-left rounded-lg hover:bg-elev transition-colors cursor-pointer">
        <Iconify icon={access.icon} size={19} class={access.full ? "text-danger" : ""} /><span class="flex-1"><span class={`font-medium ${access.full ? "text-danger" : "text-ink-100"}`}>{access.label}</span><span class={`block mt-1 text-[11px] ${access.full ? "text-danger/80" : "text-ink-500"}`}>{access.description}</span></span><Show when={c.yoloMode() === access.full}><Iconify icon="lucide:check" size={14} class={access.full ? "text-danger" : ""} /></Show>
      </button>
    }</For>
    </div>
  </FloatMenu>
</div>
</Show>
</Show>
</>
  );
}
