import { Show, type JSX } from "solid-js";

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
    <div
      class={`rounded-lg bg-brand-500 text-ink-950 flex items-center justify-center border border-brand-600/30 shadow-sm ${props.class ?? "w-8 h-8"}`}
    >
      <svg viewBox="0 0 32 32" class="w-[62%] h-[62%]" aria-hidden="true">
        <path
          d="M16 7l7 4v8l-7 4-7-4v-8z"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
        <circle cx="16" cy="15" r="2.5" fill="currentColor" />
      </svg>
    </div>
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
    >
      <div>
        <h1
          class="text-2xl leading-tight font-semibold tracking-tight"
        >
          {props.title}
        </h1>
        <Show when={props.subtitle}>
          <p class="text-xs leading-relaxed text-ink-400 mt-1.5">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}
