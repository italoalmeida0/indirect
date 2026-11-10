import { For, Show } from "solid-js";
import type { FooterFact } from "../../utils/envelope";

/** Envelope facts (exit code, page range, …) as small chips under a tool body. */
export function ToolFooter(props: { facts: FooterFact[] }) {
  return (
    <Show when={props.facts.length}>
      <div class="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1" data-tool-footer>
        <For each={props.facts}>
          {(f) => (
            <span
              class={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-tight tabular-nums ${
                f.tone === "fail"
                  ? "border-danger/40 bg-danger-subtle/40 text-danger"
                  : f.tone === "ok"
                    ? "border-success/40 bg-success-subtle/40 text-success"
                    : "border-border bg-surface text-fg-muted"
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
