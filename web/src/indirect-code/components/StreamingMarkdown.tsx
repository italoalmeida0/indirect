import { For } from "solid-js";
import { TarnavMarkdown } from "./TarnavMarkdown";
import { GenerativeUiWidget } from "./generative-ui/renderer";
import { splitGenerativeUiSegments } from "./generative-ui/dsl";
import { useComposerCtx } from "../ctx";

/**
 * Transcript adapter: the actual markdown renderer is TarnavMarkdown, with
 * one extra capability — a fenced ```generative_ui code block is NOT rendered
 * as code, it is mounted as a live interactive widget (Generative UI DSL).
 */
export function StreamingMarkdown(props: {
  children?: string;
  streaming?: boolean;
  active?: boolean;
  class?: string;
  basic?: boolean;
}) {
  const composer = useComposerCtx();
  const segments = () => splitGenerativeUiSegments(props.children || "");
  return (
    <For each={segments()}>
      {(seg) =>
        seg.kind === "md" ? (
          seg.text.trim() ? (
            <TarnavMarkdown embedded mode={props.basic ? "basic" : undefined} streaming={props.streaming} active={props.active} class={props.class}>
              {seg.text}
            </TarnavMarkdown>
          ) : null
        ) : (
          <GenerativeUiWidget
            body={() => seg.body}
            streaming={() => !!props.streaming && !seg.closed}
            onSendPrompt={(text) => {
              composer.setInputPrompt(text);
              void composer.sendPrompt();
            }}
          />
        )
      }
    </For>
  );
}
