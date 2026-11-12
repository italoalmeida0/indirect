import { For, Show, createMemo } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { parseQuestionQA } from "../../utils/toolTrees";
import type { ToolPartProps } from "./toolUnitModel";

/** Read-only history of an answered (or pending) question call: every
 * question with its options, the chosen answers highlighted. The live
 * asking happens in QuestionModal; this is the collapsible record. */
export function ToolQuestionBodies(props: ToolPartProps) {
  const items = createMemo(() =>
    parseQuestionQA(props.m.args(), props.m.output() || "", props.u.result?.toolDetails),
  );
  const answered = () => !!props.u.result;

  return (
    <Show when={props.m.name() === "question"}>
      <Show
        when={items().length > 0}
        fallback={
          <div class={`px-3 py-2 text-[11px] ${props.u.result?.isError ? "text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere]" : "text-fg-muted"}`}>
            {props.u.result?.isError
              ? props.m.output() || String(props.m.mergedEnv()?.error || "Question canceled or failed.")
              : !props.u.result
                ? props.active
                  ? "Waiting for your answers…"
                  : "Question did not complete."
                : props.m.output() || "No answer recorded."}
          </div>
        }
      >
        <div class="px-3 py-2.5 space-y-3 min-w-0 [overflow-wrap:anywhere] break-words">
          <For each={items()}>
            {(q, i) => {
              const picked = (label: string) => q.answers.includes(label);
              const custom = () =>
                q.answers.filter((a) => !q.options.some((o) => o.label === a));
              return (
                <div>
                  <div class="flex items-center gap-1.5">
                    <span class="shrink-0 rounded border border-border/70 bg-surface px-1.5 py-px font-mono text-[10px] text-fg-muted tabular-nums">
                      Q{i() + 1}
                    </span>
                    <Show when={q.header}>
                      <span class="truncate text-[12px] font-medium text-fg">{q.header}</span>
                    </Show>
                    <Show when={q.multiple}>
                      <span class="shrink-0 rounded border border-border/70 bg-surface px-1.5 py-px text-[10px] text-fg-muted">
                        multi-select
                      </span>
                    </Show>
                  </div>
                  <Show when={q.question}>
                    <p class="mt-1 text-[12.5px] leading-snug text-fg-secondary">{q.question}</p>
                  </Show>
                  <Show when={q.options.length > 0 || custom().length > 0 || !answered()}>
                    <ul class="mt-1.5 space-y-1">
                      <For each={q.options}>
                        {(o) => (
                          <li
                            class={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-snug ${
                              answered() && picked(o.label)
                                ? "border-success/40 bg-success-subtle text-fg"
                                : "border-border/70 bg-surface/50 text-fg-secondary"
                            }`}
                          >
                            <Iconify
                              icon={answered() && picked(o.label) ? "lucide:check-circle-2" : "lucide:circle"}
                              size={13}
                              class={`mt-0.5 shrink-0 ${answered() && picked(o.label) ? "text-success" : "text-fg-muted/70"}`}
                            />
                            <span class="min-w-0">
                              <span class="block font-medium">{o.label}</span>
                              <Show when={o.description}>
                                <span class="block text-[11px] text-fg-muted">{o.description}</span>
                              </Show>
                            </span>
                          </li>
                        )}
                      </For>
                      <For each={custom()}>
                        {(c) => {
                          const isDecideLater = c.startsWith("Decide later");
                          return (
                            <li
                              class={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-snug ${
                                isDecideLater
                                  ? "border-accent/40 bg-accent-subtle text-fg"
                                  : "border-success/40 bg-success-subtle text-fg"
                              }`}
                            >
                              <Iconify
                                icon={isDecideLater ? "lucide:sparkles" : "lucide:pencil"}
                                size={13}
                                class={`mt-0.5 shrink-0 ${isDecideLater ? "text-accent" : "text-success"}`}
                              />
                              <span class="min-w-0">
                                <span class="block font-medium">{c}</span>
                                <span class="block text-[11px] text-fg-muted">
                                  {isDecideLater ? "Delegated to assistant" : "Custom answer"}
                                </span>
                              </span>
                            </li>
                          );
                        }}
                      </For>
                    </ul>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={!answered()}>
            <p class="text-[11px] text-fg-muted">Waiting for your answers…</p>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
