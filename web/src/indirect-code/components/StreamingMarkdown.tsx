import { createEffect, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { TarnavMarkdown } from "./TarnavMarkdown";
import { GenerativeUiWidget } from "./generative-ui/renderer";
import {
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  type GenerativeUiSegmentWithId,
} from "./generative-ui/dsl";
import { useComposerCtx } from "../ctx";

/**
 * Transcript adapter: the actual markdown renderer is TarnavMarkdown, with
 * one extra capability — a fenced ```generative_ui code block is NOT rendered
 * as code, it is mounted as a live interactive widget (Generative UI DSL).
 *
 * Segments live in a reconciled store (same pattern as renderToolSegs):
 * TarnavMarkdown is a stateful incremental parser, so its instance must
 * survive every streamed token. A plain <For> over freshly split objects
 * remounts it per token — full reparse, visible flashing.
 */
export function StreamingMarkdown(props: {
  children?: string;
  streaming?: boolean;
  active?: boolean;
  class?: string;
  basic?: boolean;
}) {
  const composer = useComposerCtx();
  const split = () =>
    withGenerativeUiSegmentIds(splitGenerativeUiSegments(props.children || ""));
  const [state, setState] = createStore<{ segs: GenerativeUiSegmentWithId[] }>({
    segs: props.basic ? [] : split(),
  });
  createEffect(() => {
    if (!props.basic) setState("segs", reconcile(split(), { merge: true }));
  });
  // Basic mode (thinking/reasoning disclosures) never mounts widgets: a
  // generative_ui fence there renders as plain code, exactly as it did
  // before Generative UI existed. Widgets only live in final answers.
  if (props.basic) {
    return (
      <TarnavMarkdown embedded mode="basic" streaming={props.streaming} active={props.active} class={props.class}>
        {props.children}
      </TarnavMarkdown>
    );
  }
  return (
    <For each={state.segs}>
      {(seg) =>
        seg.kind === "md" ? (
          <Show when={seg.text.trim()}>
            <TarnavMarkdown embedded mode={props.basic ? "basic" : undefined} streaming={props.streaming} active={props.active} class={props.class}>
              {seg.text}
            </TarnavMarkdown>
          </Show>
        ) : (
          <GenerativeUiWidget
            body={() => seg.body}
            streaming={() => !!props.streaming && !seg.closed}
            onSendPrompt={(text) => {
              composer.setInputPrompt(text);
              void composer.sendPrompt();
            }}
            onPrefillPrompt={(text) => composer.setInputPrompt(text)}
          />
        )
      }
    </For>
  );
}
