import { createContext, createEffect, createSignal, onCleanup, Show, useContext, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat } from "../../floating";
import { createGlide } from "../motion/glide";
import { createPresence, cssExit } from "../motion/presence";
import { pushLayer } from "../primitives/layers";
import { rovingIndex } from "../primitives/a11y";
import { Glyph } from "./icon";

/**
 * A focused list of actions anchored to a trigger (Arc "Dropdown menu").
 *
 * The panel grows from the trigger edge (CSS @starting-style), rows rise in
 * with a short stagger, ONE highlight glides between rows as the pointer or
 * the arrow keys move, and closing is faster than opening. The menu joins
 * the layer stack, so Escape and outside clicks close the topmost menu
 * first (inside a dialog the dialog stays open). Focus returns to the
 * trigger on close.
 */
interface MenuContextValue {
  highlight: (el: HTMLElement | null) => void;
  close: () => void;
}

const MenuContext = createContext<MenuContextValue>();

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** The element the menu is anchored to (usually the trigger button). */
  anchor: () => HTMLElement | undefined;
  placement?: Placement;
  /** Accessible name. */
  label: string;
  class?: string;
  /** Match the trigger width. */
  matchWidth?: boolean;
  /** Return focus to the anchor when closing (default true). */
  restoreFocus?: boolean;
  children: JSX.Element;
}

export function Menu(props: MenuProps) {
  const [panel, setPanel] = createSignal<HTMLDivElement>();
  const [indicator, setIndicator] = createSignal<HTMLSpanElement>();
  const [target, setTarget] = createSignal<HTMLElement | null>(null);
  const presence = createPresence(() => props.open, { exit: (el) => cssExit(el, 130) });
  createGlide({ container: panel, indicator, target });

  const items = () => Array.from(panel()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  const close = () => {
    props.onClose();
    if (props.restoreFocus !== false) props.anchor()?.focus({ preventScroll: true });
  };

  createEffect(() => {
    if (!props.open) setTarget(null);
  });

  createEffect(() => {
    const el = panel();
    if (!props.open || !el) return;
    const remove = pushLayer({
      kind: "menu",
      contains: (node) => el.contains(node) || !!props.anchor()?.contains(node),
      onEscape: close,
      onOutside: () => props.onClose(),
    });
    onCleanup(remove);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const list = items();
    const current = list.indexOf(document.activeElement as HTMLElement);
    const next = rovingIndex(event.key, current < 0 ? -1 : current, list.length, (index) => list[index]?.getAttribute("aria-disabled") === "true", { orientation: "vertical" });
    if (next !== undefined) {
      event.preventDefault();
      list[next]?.focus({ preventScroll: true });
      setTarget(list[next] ?? null);
      return;
    }
    if (event.key === "Tab") props.onClose();
  };

  return (
    <Show when={presence.present()}>
      <Portal>
        <MenuContext.Provider value={{ highlight: setTarget, close }}>
          <div
            ref={(el) => {
              setPanel(el);
              presence.ref(el);
              const anchor = props.anchor();
              if (anchor) onCleanup(anchorFloat(anchor, el, { placement: props.placement ?? "bottom-start", gap: 6, padding: 10, matchWidth: props.matchWidth, maxHeight: 420 }));
              onCleanup(() => setPanel(undefined));
              // Keyboard users land on the first item.
              requestAnimationFrame(() => {
                if (props.open && document.activeElement === props.anchor()) {
                  const first = items().find((item) => item.getAttribute("aria-disabled") !== "true");
                  if (first && props.anchor()?.matches(":focus-visible")) { first.focus({ preventScroll: true }); setTarget(first); }
                }
              });
            }}
            role="menu"
            aria-label={props.label}
            data-glide=""
            data-floatmenu=""
            data-layer-managed=""
            data-state={presence.state()}
            tabIndex={-1}
            class={`ui-popover ui-menu ${props.open ? "" : "pointer-events-none"} ${props.class ?? ""}`}
            onKeyDown={onKeyDown}
            onPointerLeave={() => setTarget(null)}
          >
            <span ref={setIndicator} class="ui-menu-highlight" aria-hidden="true" />
            {props.children}
          </div>
        </MenuContext.Provider>
      </Portal>
    </Show>
  );
}

export interface MenuItemProps {
  icon?: string;
  /** Right-aligned hint (shortcut, count). */
  hint?: JSX.Element;
  shortcut?: JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  /** Keep the menu open after selecting (toggles). */
  keepOpen?: boolean;
  checked?: boolean;
  /** Stagger index for the entrance (0-based). */
  index?: number;
  onSelect: () => void;
  children: JSX.Element;
}

export function MenuItem(props: MenuItemProps) {
  const menu = useContext(MenuContext);
  return (
    <button
      type="button"
      role={props.checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={props.checked === undefined ? undefined : props.checked}
      aria-disabled={props.disabled ? "true" : undefined}
      style={props.index !== undefined ? { "--i": props.index } : undefined}
      class={`ui-menu-item ${props.danger ? "ui-menu-item-danger" : ""}`}
      onPointerEnter={(event) => { if (!props.disabled) menu?.highlight(event.currentTarget); }}
      onFocus={(event) => menu?.highlight(event.currentTarget)}
      onClick={() => {
        if (props.disabled) return;
        props.onSelect();
        if (!props.keepOpen) menu?.close();
      }}
    >
      <Show when={props.icon}>{(icon) => <span class="ui-menu-item-icon"><Glyph icon={icon()} size={16} /></span>}</Show>
      <span class="min-w-0 flex-1 truncate">{props.children}</span>
      <Show when={props.checked}><Glyph icon="lucide:check" size={14} class="text-accent" /></Show>
      <Show when={props.hint ?? props.shortcut}>{(h) => <span class="ui-menu-item-hint">{h()}</span>}</Show>
    </button>
  );
}

export function MenuSeparator() {
  return <div class="ui-menu-separator" role="separator" />;
}

export function MenuLabel(props: { children: JSX.Element }) {
  return <div class="ui-menu-label" role="presentation">{props.children}</div>;
}
