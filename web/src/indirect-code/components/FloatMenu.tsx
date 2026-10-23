import { onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";
import { anchorFloat } from "../../floating";

/** Local popover menu on the shared floating-ui layer (Portal + flip/shift).
 *
 * Every action inside MUST close the menu first (like the host card's
 * remove does): an open floating menu lives in a Portal above everything
 * and would otherwise cover the modal/button that follows (E2E caught
 * it: Remove left the menu open over Cancel update). When in doubt,
 * close-then-act in the handler itself — don't rely on the caller. */
export function FloatMenu(props: {
  anchor: () => HTMLElement | null | undefined;
  open: boolean;
  placement?: Placement;
  width?: string;
  onClose?: () => void;
  children: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={(el) => {
            const a = props.anchor();
            if (!a) return;
            onCleanup(anchorFloat(a, el, { placement: props.placement ?? "bottom-start", maxHeight: 520 }));
          }}
          data-floatmenu
          role="menu"
          tabIndex={-1}
          class="ui-popover anim-float-in max-w-[calc(100vw-1rem)] overflow-y-auto p-1 text-xs [scrollbar-gutter:stable] focus:outline-none"
          style={props.width ? { width: props.width } : undefined}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              props.onClose?.();
              props.anchor()?.focus();
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
              e.preventDefault();
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), [role^="menuitem"], [tabindex="0"], a[href]'
                )
              );
              if (items.length === 0) return;
              const active = document.activeElement as HTMLElement | null;
              const idx = active ? items.indexOf(active) : -1;
              if (e.key === "Home") {
                items[0]?.focus();
              } else if (e.key === "End") {
                items[items.length - 1]?.focus();
              } else if (e.key === "ArrowDown") {
                const next = idx < items.length - 1 ? idx + 1 : 0;
                items[next]?.focus();
              } else if (e.key === "ArrowUp") {
                const prev = idx > 0 ? idx - 1 : items.length - 1;
                items[prev]?.focus();
              }
            }
          }}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}

