import { Show, type JSX } from "solid-js";

import { usal } from "./motion";

/**
 * Shell pieces shared by the router and the individual pages.
 *
 * These used to live in `index.tsx`, which made every page import the app
 * entry. That is harmless with one bundle, but it prevents route-level code
 * splitting: the bundler sees the entry reachable from a lazily loaded chunk
 * and emits it twice ("Multiple files share the same output path"). Keeping
 * the shared widgets in their own module lets the entry be a leaf.
 */

export function navigate(to: string): void {
  location.hash = to;
}

export function LogoMark(props: { class?: string }) {
  return (
    <img
      src="/indirect-icon.svg"
      alt="Indirect"
      class={`object-contain shrink-0 rounded-lg ${props.class ?? "w-8 h-8"}`}
    />
  );
}

export function PageTitle(props: {
  title: string;
  subtitle?: string;
  right?: JSX.Element;
}) {
  return (
    <div
      class="relative flex flex-wrap items-end justify-between gap-3 mb-5"
      {...usal("fade-u duration-300")}
    >
      <div>
        <h1
          class="text-2xl leading-tight font-medium tracking-tight text-fg"
        >
          {props.title}
        </h1>
        <Show when={props.subtitle}>
          <p class="text-xs leading-relaxed text-fg-secondary mt-1.5">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}
