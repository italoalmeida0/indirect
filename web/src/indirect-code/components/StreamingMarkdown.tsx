import { createEffect, For, Show, useContext } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { TarnavMarkdown } from "./TarnavMarkdown";
import { GenerativeUiWidget } from "./generative-ui/renderer";
import type { WidgetAiContext, WidgetAttachPayload, WidgetAttachmentSummary } from "./generative-ui/bridge";
import {
  frozenDuplicateSegmentIds,
  splitGenerativeUiSegments,
  withGenerativeUiSegmentIds,
  type GenerativeUiSegmentWithId,
} from "./generative-ui/dsl";
import { ComposerCtx, HostCtx, SessionCtx, UICtx } from "../ctx";
import { EFFORT_SPECS } from "../utils/effortSpec";

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
  /** Disable inner code-fence / table scroll containers when mounted inside a scrolling ToolBody. */
  noNestedScroll?: boolean;
}) {
  const composer = useContext(ComposerCtx);
  const host = useContext(HostCtx);
  const session = useContext(SessionCtx);
  const ui = useContext(UICtx);
  const aiEfforts = EFFORT_SPECS.map((e) => ({
    id: e.level,
    label: e.title,
    description: e.desc,
  }));
  const aiContext = (): (WidgetAiContext & { hostId?: string }) | undefined => {
    if (!composer) return undefined;
    return {
      hostId: host?.activeHostId?.() || undefined,
      model: composer.activeModel(),
      modelName: composer.activeModelName(),
      effort: composer.effort(),
      efforts: aiEfforts,
      models: (composer.models?.() ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        context: m.context,
        output: m.output,
      })),
    };
  };
  const handleAttach = (owner: string, payload: WidgetAttachPayload) => {
    if (!composer?.upsertWidgetAttachment) return;
    const res = composer.upsertWidgetAttachment({
      owner,
      slot: payload.key,
      name: payload.name,
      mime: payload.mime,
      content: payload.content,
      dataUrl: payload.dataUrl,
    });
    if (res.ok && !res.updated) {
      if (ui?.composerCollapsed?.()) ui.setComposerCollapsed(false);
      ui?.toast?.(`Attached ${payload.name} to prompt`, "ok");
    }
  };
  const handleDetach = (owner: string, key?: string) => {
    composer?.removeWidgetAttachment?.(owner, key);
  };
  const attachmentsFor = (owner: string): WidgetAttachmentSummary[] => {
    const list = composer?.pendingAttachments?.() ?? [];
    const out: WidgetAttachmentSummary[] = [];
    for (const a of list) {
      if (a.widgetOwner !== owner) continue;
      out.push({
        key: a.widgetSlot,
        name: a.name,
        mime: a.mime,
        size: a.size,
        updatedAt: a.updatedAt,
      });
    }
    return out;
  };
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
      <TarnavMarkdown embedded mode="basic" streaming={props.streaming} active={props.active} class={props.class} noNestedScroll={props.noNestedScroll}>
        {props.children}
      </TarnavMarkdown>
    );
  }
  return (
    <For each={state.segs}>
      {(seg) =>
        seg.kind === "md" ? (
          <Show when={seg.text.trim()}>
            <TarnavMarkdown embedded mode={props.basic ? "basic" : undefined} streaming={props.streaming} active={props.active} class={props.class} noNestedScroll={props.noNestedScroll}>
              {seg.text}
            </TarnavMarkdown>
          </Show>
        ) : (
          <GenerativeUiWidget
            body={() => seg.body}
            streaming={() => !!props.streaming && !seg.closed}
            frozen={() => frozenIds().has(seg.id)}
            ctx={widgetCtx()}
            ownerKey={seg.id}
            onSendPrompt={(text) => {
              void composer?.sendWidgetPrompt(text);
            }}
            onPrefillPrompt={(text) => composer?.setInputPrompt(text)}
            onAttach={composer ? handleAttach : undefined}
            onDetach={composer ? handleDetach : undefined}
            widgetAttachments={composer ? attachmentsFor : undefined}
            aiContext={composer ? aiContext : undefined}
          />
        )
      }
    </For>
  );
}
