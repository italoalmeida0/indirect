import { For, Show, createMemo } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { parseQuestionQA } from "../../utils/toolTrees";
import type { ToolPartProps } from "./toolUnitModel";

/** Read-only history of an answered (or pending) question call: every
 * question with its options, the chosen answers highlighted. The live
 * asking happens in QuestionModal; this is the collapsible record. */
export function ToolQuestionBodies(props: ToolPartProps) {
  const items = createMemo(() =>
    parseQuestionQA(
      props.m.args(),
      props.u.result?.isError ? "" : props.m.output() || "",
      props.u.result?.isError ? undefined : props.u.result?.toolDetails,
    ),
  );
  const answered = () => Boolean(props.u.result && !props.u.result.isError);

  return (
    <Show when={props.m.name() === "question"}>
      <Show when={props.u.result?.isError}>
        <div class="border-b border-border-subtle last:border-b-0 bg-danger-subtle px-3 py-2 text-xs text-danger font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
          {(props.m.output() || "").trim() || String(props.m.mergedEnv()?.error || "Question canceled or failed.")}
        </div>
      </Show>
      <Show
        when={items().length > 0}
        fallback={
          <Show when={!props.u.result?.isError}>
            <div class="px-3 py-2 text-2xs text-fg-muted">
              {!props.u.result
                ? props.active
                  ? "Waiting for your answers…"
                  : "Question did not complete."
                : props.m.output() || "No answer recorded."}
            </div>
          </Show>
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
                    <span class="shrink-0 rounded-xs border border-border bg-surface px-1.5 py-px font-mono text-2xs text-fg-muted tabular-nums">
                      Q{i() + 1}
                    </span>
                    <Show when={q.header}>
                      <span class="truncate text-xs font-medium text-fg">{q.header}</span>
                    </Show>
                    <Show when={q.multiple}>
                      <span class="shrink-0 rounded-xs border border-border bg-surface px-1.5 py-px text-2xs text-fg-muted">
                        multi-select
                      </span>
                    </Show>
                  </div>
                  <Show when={q.question}>
                    <p class="mt-1 text-xs leading-snug text-fg-secondary">{q.question}</p>
                  </Show>
                  <Show when={q.options.length > 0 || custom().length > 0 || !answered()}>
                    <ul class="mt-1.5 space-y-1">
                      <For each={q.options}>
                        {(o) => (
                          <li
                            class={`flex items-start gap-2 rounded-inner border px-2.5 py-1.5 text-xs leading-snug ${
                              answered() && picked(o.label)
                                ? "border-border bg-success-subtle text-fg"
                                : "border-border bg-surface text-fg-secondary"
                            }`}
                          >
                            <Iconify
                              icon={answered() && picked(o.label) ? "lucide:check-circle-2" : "lucide:circle"}
                              size={13}
                              class={`mt-0.5 shrink-0 ${answered() && picked(o.label) ? "text-success" : "text-fg-muted"}`}
                            />
                            <span class="min-w-0">
                              <span class="block font-medium">{o.label}</span>
                              <Show when={o.description}>
                                <span class="block text-2xs text-fg-muted">{o.description}</span>
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
                              class={`flex items-start gap-2 rounded-inner border px-2.5 py-1.5 text-xs leading-snug ${
                                isDecideLater
                                  ? "border-border bg-accent-subtle text-fg"
                                  : "border-border bg-success-subtle text-fg"
                              }`}
                            >
                              <Iconify
                                icon={isDecideLater ? "lucide:sparkles" : "lucide:pencil"}
                                size={13}
                                class={`mt-0.5 shrink-0 ${isDecideLater ? "text-accent" : "text-success"}`}
                              />
                              <span class="min-w-0">
                                <span class="block font-medium">{c}</span>
                                <span class="block text-2xs text-fg-muted">
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
          <Show when={!props.u.result}>
            <p class="text-2xs text-fg-muted">
              {props.active ? "Waiting for your answers…" : "Question did not complete."}
            </p>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
