import { createContext, createEffect, createSignal, useContext, Show, type JSX } from "solid-js";
export { createDisclosure } from "./tool/toolUnitModel";

/** Expensive descendants can pause while any ancestor disclosure is closed. */
export const DisclosureActive = createContext<() => boolean>(() => true);
export const useDisclosureActive = () => useContext(DisclosureActive);

/** Mount expensive details on first use, then hide them without losing DOM/scroll. */
export function DisclosureBody(props: { open: boolean; class?: string; children: JSX.Element }) {
  const parentActive = useDisclosureActive();
  const [visited, setVisited] = createSignal(false);
  createEffect(() => { if (props.open) setVisited(true); });
  return <Show when={visited() || props.open}>
    <div class={props.class} style={{ display: props.open ? undefined : "none" }}><DisclosureActive.Provider value={() => props.open && parentActive()}>{props.children}</DisclosureActive.Provider></div>
  </Show>;
}
