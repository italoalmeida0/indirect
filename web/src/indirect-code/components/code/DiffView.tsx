import { createEffect, createSignal, For, Show, onCleanup } from "solid-js";
import { escapeHtml, highlightCode, languageForPath } from "../../utils/lang";
import { diffRows, type ParsedDiffLine } from "../../utils/diffLines";
import { recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";

/**
 * Renders a unified context diff (daemon edit results and turn-change
 * balloons). Diff marker lines (+/-) keep their red/green lane so
 * added/removed still jump out; the line BODY is syntax-highlighted per the
 * file extension. Line numbers come embedded ("<n>:[ +-]code") or are
 * derived from the @@ hunk headers of plain unified diffs; a truncate
 * control caps long diffs exactly like the file preview.
 */
export interface DiffRow {
  lineNum: string;
  marker: string;
  codeHtml: string;
  rawCode: string;
  kind: ParsedDiffLine["kind"];
}

/**
 * Renders a unified context diff (daemon edit results and turn-change
 * balloons). Diff marker lines (+/-) keep their red/green lane with an
 * isolated line-number gutter; the line BODY is syntax-highlighted per the
 * file extension without marker/number interference.
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
  const [rows, setRows] = createSignal<DiffRow[] | null>(null);
  const lines = () => diffRows(props.text || "");
  const max = () => props.max ?? 80;
  const shown = () => {
    const all = lines();
    return expanded() ? all : all.slice(0, max());
  };
  const hidden = () => Math.max(0, lines().length - shown().length);

  createEffect(() => {
    const currentLines = shown();
    const lang = languageForPath(props.name);
    let cancelled = false;

    void Promise.all(
      currentLines.map(async (p) => {
        let codeHtml: string;
        if (p.kind === "header" || p.kind === "ellipsis") {
          codeHtml = escapeHtml(p.code);
        } else {
          codeHtml = await highlightCode(p.code, lang);
        }
        return {
          lineNum: p.lineNum,
          marker: p.marker,
          codeHtml,
          rawCode: p.code,
          kind: p.kind,
        };
      }),
    ).then((result) => {
      if (!cancelled) {
        setRows(result);
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, containerRef));
      }
    }).catch(() => {
      if (!cancelled) {
        setRows(
          currentLines.map((p) => ({
            lineNum: p.lineNum,
            marker: p.marker,
            codeHtml: escapeHtml(p.code),
            rawCode: p.code,
            kind: p.kind,
          })),
        );
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, containerRef));
      }
    });

    onCleanup(() => {
      cancelled = true;
    });
  });

  const hasGutter = () => shown().some((r) => r.lineNum !== "");

  return (
    <div
      ref={(el) => {
        containerRef = el;
        if (props.embedded) return;
        restoreToolScroll(props.scrollKey, el);
        requestAnimationFrame(() => restoreToolScroll(props.scrollKey, el));
      }}
      onScroll={props.embedded ? undefined : (e) => recordToolScroll(props.scrollKey, e.currentTarget)}
      class={`font-mono text-[11.5px] leading-relaxed select-text ${
        props.embedded
          ? "overflow-visible"
          : "overflow-x-auto overflow-y-auto [scrollbar-gutter:stable] max-h-96"
      }`}
    >
      <div class="min-w-full w-fit">
        <Show
          when={rows() !== null}
          fallback={
            <For each={shown()}>
              {(r) => (
                <div
                  class={`flex items-start pr-2.5 py-0.5 whitespace-pre ${
                    r.kind === "add"
                      ? "rc-diff-row-add text-success"
                      : r.kind === "del"
                        ? "rc-diff-row-del text-danger"
                        : r.kind === "header"
                          ? "rc-diff-row-ctx text-fg-muted text-[10px]"
                          : r.kind === "ellipsis"
                            ? "rc-diff-row-ctx text-fg-muted/70"
                            : "rc-diff-row-ctx text-fg-secondary"
                  }`}
                >
                  <div class="sticky left-0 z-10 flex items-start bg-inherit pl-2.5 pr-1 shrink-0">
                    <Show when={hasGutter()}>
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
                  {/* eslint-disable-next-line solid/no-innerhtml */}
                  <code class="tok flex-1" innerHTML={escapeHtml(r.code || " ")} />
                </div>
              )}
            </For>
          }
        >
          <For each={rows()}>
            {(r) => (
              <div
                class={`flex items-start pr-2.5 py-0.5 whitespace-pre ${
                  r.kind === "add"
                    ? "rc-diff-row-add"
                    : r.kind === "del"
                      ? "rc-diff-row-del"
                      : r.kind === "header"
                        ? "rc-diff-row-ctx text-fg-muted text-[10px]"
                        : r.kind === "ellipsis"
                          ? "rc-diff-row-ctx text-fg-muted/70"
                          : "rc-diff-row-ctx text-fg-secondary"
                }`}
              >
                <div class="sticky left-0 z-10 flex items-start bg-inherit pl-2.5 pr-1 shrink-0">
                  <Show when={hasGutter()}>
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
                {/* eslint-disable-next-line solid/no-innerhtml */}
                <code class="tok flex-1" innerHTML={r.codeHtml || " "} />
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={hidden() > 0}>
        <button
          type="button"
          onClick={() => {
            setExpanded(true);
            requestAnimationFrame(() => {
              containerRef?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            });
          }}
          class="w-full text-left px-3 py-1.5 border-t border-border/50 bg-surface-subtle text-[11px] font-mono text-fg-muted hover:text-fg hover:bg-surface-muted/60 transition-colors cursor-pointer"
        >
          +{hidden()} more lines
        </button>
      </Show>
    </div>
  );
}
