import type { JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";

/** Shared menu item for FloatMenu popovers (same class across all
 * context/file/sidebar menus, extracted to a single place). */
export function MenuItem(props: {
  icon?: string;
  iconSize?: number;
  iconClass?: string;
  children: JSX.Element;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  role?: JSX.HTMLAttributes<HTMLButtonElement>["role"];
  tip?: string;
}) {
  return (
    <button
      type="button"
      role={props.role}
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={props.onClick}
      data-rc-tip={props.tip}
      aria-label={props.tip}
      class={
        props.class ??
        "ui-menu-item w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors flex items-center gap-2 cursor-pointer"
      }
    >
      {props.icon ? <Iconify icon={props.icon} size={props.iconSize ?? 13} class={props.iconClass} /> : null}
      {props.children}
    </button>
  );
}
