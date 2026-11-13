import { For, Show } from "solid-js";
import type { FooterFact } from "../../utils/envelope";

/** Envelope facts (exit code, page range, …) as quiet inline metadata under a tool body. */
export function ToolFooter(props: { facts: FooterFact[] }) {
  return (
    <Show when={props.facts.length}>
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border-subtle px-3 py-1.5" data-tool-footer>
        <For each={props.facts}>
          {(f) => (
            <span
              class={`font-mono text-2xs leading-tight tabular-nums ${
                f.tone === "fail"
                  ? "text-danger"
                  : f.tone === "ok"
                    ? "text-success"
                    : "text-fg-muted"
              }`}
            >
              {f.label}
            </span>
          )}
        </For>
      </div>
    </Show>
  );
}
