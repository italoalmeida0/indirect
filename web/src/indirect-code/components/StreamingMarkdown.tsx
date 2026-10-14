import { createEffect, For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { TarnavMarkdown } from "./TarnavMarkdown";
import { GenerativeUiWidget } from "./generative-ui/renderer";
import {
  frozenDuplicateSegmentIds,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  type GenerativeUiSegmentWithId,
} from "./generative-ui/dsl";
import { useComposerCtx, useHost, useSession } from "../ctx";

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
  const host = useHost();
  const session = useSession();
  // Widget source access (WS get_widget) — only when the page mounted the
  // contexts (plain fixtures render the static card).
  const widgetCtx = () => {
    const sid = session?.activeSessionId?.();
    const hid = host?.activeHostId?.();
    const send = host?.send;
    if (!sid || !hid || !send) return undefined;
    return { send: send as (payload: { type: "get_widget"; sessionId: string; requestId: string; widgetId: string }) => void, hostId: hid, sessionId: sid };
  };
  const split = () =>
    withGenerativeUiSegmentIds(splitGenerativeUiSegments(props.children || ""));
  // Duplicate fences for the same widget_id: only the LAST mounts live
  // (earlier duplicates freeze — see frozenDuplicateSegmentIds).
  const frozenIds = () => frozenDuplicateSegmentIds(split());
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
            frozen={() => frozenIds().has(seg.id)}
            ctx={widgetCtx()}
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
