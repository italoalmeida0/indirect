import { createEffect, createMemo, createSignal, For, Show, onCleanup } from "solid-js";
import { press } from "../../../ds/motion/press";
import {
  isCodeHighlightReady,
  languageForPath,
  preloadCodeHighlight,
} from "../../utils/lang";
import { diffRows } from "../../utils/diffLines";
import {
  buildDiffRows,
  buildDiffRowsSync,
  type DiffRow,
} from "../../utils/inlineDiff";
import { recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";

export { buildDiffRows, buildDiffRowsSync, type DiffRow };

const FOLD_LOOKAHEAD_LINES = 24;

/**
 * Renders a unified context diff (daemon edit results and turn-change
 * balloons). Diff marker lines (+/-) keep their semantic lane with dual
 * old/new line-number gutters (for unified `@@` diffs) or a single line-number
 * gutter (for daemon numbered edit results), dedicated `@@` hunk header bars,
 * stateful multi-line syntax highlighting across hunks, and VS Code / GitHub
 * intra-line word & character diff highlights.
 */
export function DiffView(props: {
  text: string;
  max?: number;
  name?: string;
  scrollKey?: string;
  /** Embedded in a scrolling tool body: no own cap or scrollbar. */
  embedded?: boolean;
}) {
  let containerRef: HTMLDivElement | null = null;
  const [expanded, setExpanded] = createSignal(false);
  const [hlReady, setHlReady] = createSignal(isCodeHighlightReady());

  const allLines = createMemo(() => diffRows(props.text || ""));
  const max = () => props.max ?? 80;
  const shownCount = createMemo(() => {
    const total = allLines().length;
    return expanded() ? total : Math.min(total, max());
  });
  const hidden = createMemo(() => Math.max(0, allLines().length - shownCount()));

  const isDualGutter = createMemo(() =>
    allLines().some((r) => r.oldLineNum !== undefined || r.newLineNum !== undefined),
  );
  const hasSingleGutter = createMemo(
    () => !isDualGutter() && allLines().some((r) => r.lineNum !== ""),
  );
  const dualColWidth = createMemo(() => {
    let maxDigits = 2;
    for (const r of allLines()) {
      if (r.oldLineNum && r.oldLineNum.length > maxDigits) maxDigits = r.oldLineNum.length;
      if (r.newLineNum && r.newLineNum.length > maxDigits) maxDigits = r.newLineNum.length;
    }
    return `${Math.max(2.1, (maxDigits + 1.15) * 0.56).toFixed(2)}rem`;
  });

  const rows = createMemo<DiffRow[]>(() => {
    hlReady();
    const all = allLines();
    const count = shownCount();
    if (count === 0) return [];
    const windowEnd = expanded() ? all.length : Math.min(all.length, count + FOLD_LOOKAHEAD_LINES);
    const lang = languageForPath(props.name);
    return buildDiffRowsSync(all.slice(0, windowEnd), lang).slice(0, count);
  });

  createEffect(() => {
    const lang = languageForPath(props.name);
    if (!lang || hlReady()) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    void preloadCodeHighlight()
      .then(() => {
        if (!cancelled) setHlReady(true);
      })
      .catch(() => {});
  });

  createEffect(() => {
    rows();
    if (props.embedded) return;
    requestAnimationFrame(() => restoreToolScroll(props.scrollKey, containerRef));
  });

  return (
    <div
      ref={(el) => {
        containerRef = el;
        if (props.embedded) return;
        restoreToolScroll(props.scrollKey, el);
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, el));
      }}
      onScroll={props.embedded ? undefined : (e) => recordToolScroll(props.scrollKey, e.currentTarget)}
      class={`font-mono text-xs leading-relaxed select-text ${
        props.embedded
          ? "overflow-visible"
          : "overflow-x-auto overflow-y-auto max-h-96"
      }`}
    >
      <div class="min-w-full w-fit">
        <For each={rows()}>
          {(r) => (
            <Show
              when={!r.hunkHeader}
              fallback={
                <div class="rc-diff-hunk flex items-center pr-2.5 py-1 whitespace-pre">
                  <div class="sticky left-0 z-10 flex items-center bg-inherit pl-2.5 pr-1 shrink-0">
                    <Show when={isDualGutter()}>
                      <span
                        class="rc-code-gutter-old select-none text-right font-mono text-[10px] tabular-nums shrink-0 pr-1.5"
                        style={{ "min-width": dualColWidth() }}
                      />
                      <span
                        class="rc-code-gutter select-none text-right font-mono text-[10px] tabular-nums shrink-0 pr-2 mr-1.5"
                        style={{ "min-width": dualColWidth() }}
                      >
                        ⋯
                      </span>
                    </Show>
                    <Show when={hasSingleGutter()}>
                      <span class="rc-code-gutter select-none text-right font-mono text-[10px] tabular-nums min-w-[2.5rem] shrink-0 pr-2 mr-1.5">
                        ⋯
                      </span>
                    </Show>
                    <span class="select-none w-4 shrink-0 text-center text-transparent"> </span>
                  </div>
                  <code class="font-mono text-[11px] flex-1">
                    <span class="rc-diff-hunk-range">{r.hunkHeader!.range}</span>
                    <Show when={r.hunkHeader!.context}>
                      <span class="rc-diff-hunk-ctx"> {r.hunkHeader!.context}</span>
                    </Show>
                  </code>
                </div>
              }
            >
              <div
                class={`flex items-start pr-2.5 py-0.5 whitespace-pre ${
                  r.kind === "add"
                    ? "rc-diff-row-add"
                    : r.kind === "del"
                      ? "rc-diff-row-del"
                      : r.kind === "meta"
                        ? "rc-diff-meta text-fg-muted"
                        : r.kind === "header"
                          ? "rc-diff-row-ctx text-fg-muted text-[10px]"
                          : r.kind === "ellipsis"
                            ? "rc-diff-row-ctx text-fg-muted"
                            : "rc-diff-row-ctx text-fg-secondary"
                }`}
              >
                <div class="sticky left-0 z-10 flex items-start bg-inherit pl-2.5 pr-1 shrink-0">
                  <Show when={isDualGutter()}>
                    <span
                      class="rc-code-gutter-old select-none text-right font-mono text-[10px] tabular-nums shrink-0 pr-1.5"
                      style={{ "min-width": dualColWidth() }}
                    >
                      {r.oldLineNum || ""}
                    </span>
                    <span
                      class="rc-code-gutter select-none text-right font-mono text-[10px] tabular-nums shrink-0 pr-2 mr-1.5"
                      style={{ "min-width": dualColWidth() }}
                    >
                      {r.newLineNum || ""}
                    </span>
                  </Show>
                  <Show when={hasSingleGutter()}>
                    <span class="rc-code-gutter select-none text-right font-mono text-[10px] tabular-nums min-w-[2.5rem] shrink-0 pr-2 mr-1.5">
                      {r.lineNum || ""}
                    </span>
                  </Show>
                  <span
                    class={`select-none w-4 shrink-0 text-center font-medium ${
                      r.kind === "add"
                        ? "text-success"
                        : r.kind === "del"
                          ? "text-danger"
                          : "text-transparent"
                    }`}
                  >
                    {r.marker || " "}
                  </span>
                </div>
                <Show
                  when={r.kind !== "meta"}
                  fallback={
                    <code class="font-mono text-[10.5px] italic text-fg-muted flex-1">
                      {r.rawCode || " "}
                    </code>
                  }
                >
                  {/* eslint-disable-next-line solid/no-innerhtml */}
                  <code class="tok flex-1" innerHTML={r.codeHtml || " "} />
                </Show>
              </div>
            </Show>
          )}
        </For>
      </div>
      <Show when={hidden() > 0}>
        <button
          type="button"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => {
            setExpanded(true);
            requestAnimationFrame(() => {
              containerRef?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            });
          }}
          class="flex items-center w-full min-h-8 [@media(pointer:coarse)]:min-h-11 text-left px-3 py-1.5 border-t border-border-subtle bg-surface-subtle text-2xs font-mono text-fg-muted hover:text-fg hover:bg-surface-muted/60 transition-colors cursor-pointer"
        >
          +{hidden()} more lines
        </button>
      </Show>
    </div>
  );
}
