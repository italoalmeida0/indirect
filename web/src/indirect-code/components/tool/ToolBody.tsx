import { onCleanup } from "solid-js";
import { followTail, recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";
import { ToolFooter } from "./ToolFooter";
import { ToolContextBodies } from "./ToolContextBodies";
import { ToolEditBodies } from "./ToolEditBodies";
import { ToolSearchBodies } from "./ToolSearchBodies";
import { ToolQuestionBodies } from "./ToolQuestionBodies";
import { ToolWidgetBodies } from "./ToolWidgetBodies";
import type { ToolPartProps } from "./toolUnitModel";

/** Tools whose body is wrapped prose/cards rather than unwrapped horizontal code/terminal output. */
const WRAPPED_TOOL_BODIES: ReadonlySet<string> = new Set([
  "explore",
  "session_history",
  "summary",
  "finish_entire_request",
  "question",
  "todo",
  "todowrite",
  "todoread",
  "use_skill",
  "bg_cancel",
  "fetch_url",
]);

/**
 * The scrolling container of one tool body. It is the ONLY scroll surface of
 * a tool: the body components render their blocks with overflow-visible, so a
 * tool never shows nested scrollbars. Scroll position and tail-follow are
 * recorded here on the tool's row key.
 */
export function ToolBody(props: ToolPartProps) {
  const isWrapped = () => WRAPPED_TOOL_BODIES.has(props.m.name());
  return (
    <div
      data-tool-body={props.m.name()}
      ref={(el) => {
        restoreToolScroll(props.m.key(), el);
        requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
        onCleanup(followTail(el, () => props.m.open() && props.running));
      }}
      onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
      class="mt-1 mb-2 rounded-control border border-border bg-surface-subtle max-h-96 overflow-auto overscroll-contain"
    >
      {/* Code/diff/terminal tools use min-w-full w-fit so separator borders stretch
          across horizontal scroll; wrapped prose/context tools stay bounded to w-full
          min-w-0 max-w-full so long tokens wrap cleanly on narrow mobile viewports. */}
      <div class={isWrapped() ? "w-full min-w-0 max-w-full" : "min-w-full w-fit"}>
        <ToolSearchBodies {...props} />
        <ToolEditBodies {...props} />
        <ToolContextBodies {...props} />
        <ToolQuestionBodies {...props} />
        <ToolWidgetBodies {...props} />
        <ToolFooter facts={props.m.footer()} />
      </div>
    </div>
  );
}
