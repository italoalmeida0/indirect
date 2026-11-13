import { createContext, createEffect, createSignal, useContext, Show, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
export { createDisclosure } from "./tool/toolUnitModel";

/** Expensive descendants can pause while any ancestor disclosure is closed. */
export const DisclosureActive = createContext<() => boolean>(() => true);
export const useDisclosureActive = () => useContext(DisclosureActive);

export interface DisclosureTriggerProps {
  open: boolean;
  onClick: () => void;
  "aria-expanded"?: boolean;
  "aria-label"?: string;
  "data-step-rail-header"?: boolean | "";
  chevronSize?: number;
  chevronClass?: string;
  hideChevron?: boolean;
  class?: string;
  children: JSX.Element;
}

/** Shared full-row disclosure button with 20px icon+gap axis. */
export function DisclosureTrigger(props: DisclosureTriggerProps) {
  return (
    <button
      type="button"
      aria-expanded={props["aria-expanded"] ?? props.open}
      aria-label={props["aria-label"]}
      data-step-rail-header={props["data-step-rail-header"]}
      onPointerDown={(e) => press(e.currentTarget)}
      onClick={props.onClick}
      class={`group/disc flex w-[calc(100%+0.75rem)] -mx-1.5 px-1.5 py-0.5 items-center gap-1.5 rounded-md text-left cursor-pointer hover:bg-surface-muted/60 transition-colors ${props.class ?? ""}`}
    >
      <Show when={!props.hideChevron}>
        <span class="inline-flex w-3.5 shrink-0 items-center justify-center">
          <Iconify
            icon="lucide:chevron-right"
            size={props.chevronSize ?? 12}
            class={`shrink-0 text-fg-muted group-hover/disc:text-fg-secondary transition-transform duration-150 ${props.open ? "rotate-90" : ""} ${props.chevronClass ?? ""}`}
          />
        </span>
      </Show>
      {props.children}
    </button>
  );
}

/** Mount expensive details on first use; optionally release DOM when closed (`keepMounted={false}`). */
export function DisclosureBody(props: { open: boolean; keepMounted?: boolean; class?: string; children: JSX.Element }) {
  const parentActive = useDisclosureActive();
  const [visited, setVisited] = createSignal(false);
  createEffect(() => {
    if (props.open) setVisited(true);
    else if (props.keepMounted === false) setVisited(false);
  });
  return <Show when={props.open || (props.keepMounted !== false && visited())}>
    <div class={props.class} style={{ display: props.open ? undefined : "none" }}><DisclosureActive.Provider value={() => props.open && parentActive()}>{props.children}</DisclosureActive.Provider></div>
  </Show>;
}
