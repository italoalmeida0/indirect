import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { CodeBlock, DiffView, stripLinePrefixNotice } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { languageForPath } from "../../utils/lang";
import { parseEditResults, synthesizeEditSectionsFromArgs } from "../../utils/toolEdits";
import type { FileEditSection } from "../../utils/toolEdits";
import {
  baseNameOf,
  diffStat,
  formatImageBytes,
  type ImageReadDetails,
} from "../../transcript";
import type { ToolPartProps } from "./toolUnitModel";

function ImageReadCard(props: {
  info: ImageReadDetails;
  hasResult: boolean;
  active: boolean;
}) {
  const filePath = () => props.info.path || "image";
  const fileName = () => baseNameOf(props.info.path) || props.info.path || "image";
  const hasSignificantSavings = () => {
    const b = props.info.bytes;
    const ob = props.info.origBytes;
    return b !== undefined && ob !== undefined && b > 0 && ob > b * 1.15;
  };
  const savedPercent = () => {
    const b = props.info.bytes;
    const ob = props.info.origBytes;
    if (!b || !ob || ob <= b) return 0;
    return Math.min(99, Math.max(1, Math.round((1 - b / ob) * 100)));
  };

  return (
    <div data-tool-image-read class="px-3 py-2.5 min-w-0 max-w-full">
      <Show
        when={props.hasResult}
        fallback={
          <div class="flex items-center gap-2 flex-wrap min-w-0 text-xs">
            <Show when={props.active}>
              <span class="ui-spinner text-accent shrink-0" />
            </Show>
            <FileIcon path={filePath()} size={14} />
            <span
              data-rc-tip={props.info.path || undefined}
              class="font-mono font-medium text-fg truncate min-w-0 max-w-full"
            >
              {fileName()}
            </span>
            <Show when={props.info.formatLabel}>
              <span class="rounded-xs border border-border bg-surface px-1.5 py-px font-mono text-2xs text-fg-secondary shrink-0">
                {props.info.formatLabel}
              </span>
            </Show>
            <span class="text-fg-muted">
              {props.active ? "Inspecting image…" : "Image read did not complete."}
            </span>
          </div>
        }
      >
        <div
          class={
            props.info.previewDataUrl
              ? "flex flex-col sm:flex-row sm:items-start gap-3 min-w-0 max-w-full"
              : "flex items-start gap-2.5 min-w-0 max-w-full"
          }
        >
          <Show
            when={props.info.previewDataUrl}
            fallback={
              <div
                data-image-icon-tile
                class="pt-0.5 shrink-0 flex items-center justify-center"
              >
                <Iconify icon="lucide:image" size={16} class="text-fg-muted" />
              </div>
            }
          >
            {(previewUrl) => (
              <div
                data-image-preview
                class="shrink-0 self-start rounded-inner border border-border bg-surface overflow-hidden max-w-full"
              >
                <img
                  src={previewUrl()}
                  alt={fileName()}
                  loading="lazy"
                  class="max-h-44 max-w-full w-auto object-contain block"
                />
              </div>
            )}
          </Show>

          <div class="min-w-0 flex-1 space-y-1.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <FileIcon path={filePath()} size={14} />
              <span
                data-rc-tip={props.info.path || undefined}
                class="font-mono text-xs font-medium text-fg truncate min-w-0"
              >
                {fileName()}
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-1.5 min-w-0">
              <span
                data-image-format-badge
                class={`inline-flex items-center rounded-xs border px-1.5 py-0.5 font-mono text-2xs font-medium shrink-0 ${
                  props.info.converted
                    ? "border-border-subtle bg-accent-subtle text-accent"
                    : "border-border bg-surface text-fg-secondary"
                }`}
              >
                {props.info.converted && props.info.origFormatLabel
                  ? `${props.info.origFormatLabel} → ${props.info.formatLabel}`
                  : props.info.formatLabel}
              </span>

              <Show when={props.info.width && props.info.height}>
                <span
                  data-image-dimensions-pill
                  class="inline-flex items-center rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-secondary tabular-nums shrink-0"
                >
                  {props.info.resized && props.info.origWidth && props.info.origHeight
                    ? `${props.info.origWidth}×${props.info.origHeight} → ${props.info.width}×${props.info.height} px`
                    : `${props.info.width}×${props.info.height} px`}
                </span>
              </Show>

              <Show when={props.info.bytes && props.info.bytes > 0}>
                <span
                  data-image-wire-size-pill
                  class="inline-flex items-center gap-1 rounded-xs border border-border bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-secondary tabular-nums shrink-0"
                >
                  <span>
                    {hasSignificantSavings()
                      ? `${formatImageBytes(props.info.origBytes!)} → ${formatImageBytes(props.info.bytes!)}`
                      : formatImageBytes(props.info.bytes!)}
                  </span>
                </span>
              </Show>

              <Show when={hasSignificantSavings() && savedPercent() > 0}>
                <span
                  data-image-savings-badge
                  class="inline-flex items-center rounded-xs border border-border-subtle bg-success-subtle px-1.5 py-0.5 font-mono text-2xs font-medium text-success tabular-nums shrink-0"
                >
                  -{savedPercent()}%
                </span>
              </Show>
            </div>

            <Show when={props.info.hints.length > 0}>
              <div class="space-y-0.5 pt-0.5">
                <For each={props.info.hints}>
                  {(hint) => (
                    <div class="text-2xs text-fg-muted leading-snug whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
                      {hint}
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function FileEditCard(props: { sec: FileEditSection; scrollKey?: string; hideHeader?: boolean }) {
  const [open, setOpen] = createSignal(true);
  const stat = () => diffStat(props.sec.diff);
  const effectiveOpen = () => (props.hideHeader ? true : open());

  return (
    <div data-edit-file={props.sec.file || undefined} class="border-b border-border-subtle last:border-b-0">
      <Show when={!props.hideHeader}>
        <button
          type="button"
          aria-expanded={open()}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => setOpen(!open())}
          class="group/file w-full flex items-center justify-between gap-2 min-h-8 [@media(pointer:coarse)]:min-h-11 px-3 py-1.5 bg-surface-subtle hover:bg-surface-muted/60 text-xs text-left cursor-pointer transition-colors"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <Iconify
              icon="lucide:chevron-right"
              size={12}
              class={`shrink-0 text-fg-muted transition-transform duration-150 ${open() ? "rotate-90" : ""}`}
            />
            <FileIcon path={props.sec.file} size={14} />
            <span class="font-mono font-medium text-fg truncate">{props.sec.file || "edit"}</span>
            <Show when={props.sec.status === "error"}>
              <span class="text-2xs px-1.5 py-0.5 rounded-xs bg-danger-subtle text-danger font-mono shrink-0">
                failed
              </span>
            </Show>
            <Show when={props.sec.status === "dry_run"}>
              <span class="text-2xs px-1.5 py-0.5 rounded-xs bg-warning-subtle text-warning font-mono shrink-0">
                preview
              </span>
            </Show>
            <Show when={stat().add > 0 || stat().del > 0}>
              <span class="font-mono text-2xs shrink-0 tabular-nums ml-auto">
                <Show when={stat().add > 0}>
                  <span class="text-success">+{stat().add}</span>
                </Show>
                <Show when={stat().add > 0 && stat().del > 0}>
                  <span class="text-fg-muted"> </span>
                </Show>
                <Show when={stat().del > 0}>
                  <span class="text-danger">-{stat().del}</span>
                </Show>
              </span>
            </Show>
            <Show when={props.sec.matches !== undefined && stat().add === 0 && stat().del === 0}>
              <span class="text-2xs px-1.5 py-0.5 rounded-xs bg-surface-muted text-fg-secondary font-mono shrink-0 ml-auto">
                {props.sec.matches} {props.sec.matches === 1 ? "match" : "matches"}
              </span>
            </Show>
          </div>
        </button>
      </Show>
      <Show when={effectiveOpen()}>
        <Show when={props.sec.error}>
          <div class={`px-3 py-2 text-xs text-danger font-mono bg-danger-subtle whitespace-pre-wrap ${props.hideHeader ? "" : "border-t border-border-subtle"}`}>
            {props.sec.error}
          </div>
        </Show>
        <Show when={props.sec.diff}>
          <div class={props.hideHeader && !props.sec.error ? "" : "border-t border-border-subtle"}>
            <DiffView text={props.sec.diff} max={60} name={props.sec.file} scrollKey={props.scrollKey} embedded />
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function ToolEditBodies(props: ToolPartProps) {
  const defaultPath = () => {
    const a = props.m.args();
    if (a.path) return String(a.path);
    if (a.file) return String(a.file);
    if (props.m.mergedEnv()?.path) return String(props.m.mergedEnv()!.path);
    if (Array.isArray(a.edits) && a.edits.length === 1) {
      return String(a.edits[0]?.path || a.edits[0]?.file || "");
    }
    return "";
  };

  const isDryRun = () =>
    Boolean(
      props.u.result?.toolDetails?.dry_run === true ||
        props.m.args().dry_run === true ||
        props.m.mergedEnv()?.dry_run === "true",
    );

  const sections = createMemo<FileEditSection[]>(() => {
    const n = props.m.name();
    if (n !== "edit" && n !== "patch") return [];
    const d: any = props.u.result?.toolDetails;
    const res = String(d?.display ?? d?.diff ?? props.m.output() ?? "");
    const parsed = parseEditResults(res, defaultPath());
    if (parsed.length > 0) {
      if (props.u.result?.isError) {
        return parsed.map((sec) =>
          sec.status === "error"
            ? sec
            : {
                ...sec,
                status: "error",
                error: sec.error || sec.diff || "Failed to apply edit.",
                diff: sec.error ? sec.diff : "",
              },
        );
      }
      return parsed;
    }
    if (props.u.result?.isError) {
      const errMsg =
        res.trim() ||
        String(props.m.mergedEnv()?.error || "").trim() ||
        "Failed to apply edit.";
      return [
        {
          file: defaultPath() || (n === "patch" ? "patch" : "edit"),
          status: "error",
          error: errMsg,
          diff: "",
        },
      ];
    }
    // Persisted WAL (`<tool_result type="ok" info="..." path="..." edits="1"></tool_result>`)
    // omits transient `toolDetails.display` and has an empty body: synthesize the diff
    // directly from the tool arguments so reload preserves the file edit card + hunks.
    const synth = synthesizeEditSectionsFromArgs(
      props.m.args(),
      defaultPath(),
      isDryRun() ? "dry_run" : "applied",
    );
    if (synth.length > 0 && props.u.result) {
      const envEdits = Number(props.m.mergedEnv()?.edits);
      if (synth.length === 1 && Number.isFinite(envEdits) && envEdits > 0 && synth[0].matches === undefined) {
        synth[0] = { ...synth[0], matches: envEdits };
      }
    }
    return synth;
  });

  const readText = createMemo(() => {
    if (props.m.name() !== "read" || props.u.result?.isError) return "";
    const raw = String((props.u.result?.toolDetails?.display ?? props.m.output()) || props.m.prog() || "");
    return stripLinePrefixNotice(raw);
  });

  const writeText = createMemo(() => {
    if (props.m.name() !== "write" || props.u.result?.isError) return "";
    const raw = String(
      (props.u.result?.toolDetails?.display ?? props.m.output()) ||
        props.m.args().content ||
        props.m.prog() ||
        "",
    );
    return stripLinePrefixNotice(raw);
  });

  return (
    <>
      <Show when={props.m.name() === "edit" || props.m.name() === "patch"}>
        <Show when={isDryRun()}>
          <div class="px-3 py-1.5 bg-surface-subtle border-b border-border-subtle">
            <span class="inline-flex items-center gap-1.5 rounded-inner border border-border-subtle bg-warning-subtle px-2 py-0.5 text-2xs text-warning">
              <Iconify icon="lucide:eye" size={12} /> Dry run · no files written
            </span>
          </div>
        </Show>
        <Show
          when={Boolean(props.u.result)}
          fallback={
            <>
              <div class="px-3 py-2 text-2xs text-fg-muted">
                {props.active
                  ? isDryRun()
                    ? "Previewing edit…"
                    : "Applying edit…"
                  : isDryRun()
                    ? "Edit preview did not complete."
                    : "Edit did not complete."}
              </div>
              <Show when={sections().length > 0}>
                <div class="border-t border-border-subtle">
                  <For each={sections()}>
                    {(sec) => (
                      <FileEditCard
                        sec={sec}
                        scrollKey={`${props.m.key()}:${sec.file}`}
                        hideHeader={sections().length === 1 && Boolean(sec.diff || sec.error)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </>
          }
        >
          <Show
            when={sections().length > 0}
            fallback={
              <div class="px-3 py-2 text-2xs text-fg-muted">
                {String(props.m.mergedEnv()?.info || "No changes.")}
              </div>
            }
          >
            <For each={sections()}>
              {(sec) => (
                <FileEditCard
                  sec={sec}
                  scrollKey={`${props.m.key()}:${sec.file}`}
                  hideHeader={sections().length === 1 && Boolean(sec.diff || sec.error)}
                />
              )}
            </For>
          </Show>
        </Show>
      </Show>

      <Show when={props.m.name() === "read"}>
        <Show
          when={!props.u.result?.isError}
          fallback={
            <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
              {stripLinePrefixNotice(props.m.output() || "").trim() ||
                String(props.m.mergedEnv()?.error || "Failed to read file.")}
            </div>
          }
        >
          <Show
            when={props.m.imageReadDetails()}
            fallback={
              <Show
                when={readText().trim().length > 0}
                fallback={
                  <div class="px-3 py-2 text-[11px] text-fg-muted">
                    {!props.u.result
                      ? props.active
                        ? "Reading file…"
                        : "File read did not complete."
                      : "Empty file (0 bytes)."}
                  </div>
                }
              >
                <CodeBlock
                  embedded
                  numbered
                  follow={() => props.m.open() && props.running}
                  text={readText()}
                  language={languageForPath(String(props.m.args().path || ""))}
                  wrap={false}
                  scrollKey={props.m.key()}
                />
              </Show>
            }
          >
            {(info) => (
              <ImageReadCard
                info={info()}
                hasResult={Boolean(props.u.result)}
                active={props.active}
              />
            )}
          </Show>
        </Show>
      </Show>

      <Show when={props.m.name() === "write"}>
        <Show
          when={!props.u.result?.isError}
          fallback={
            <div class="px-3 py-2 text-xs text-danger bg-danger-subtle font-mono whitespace-pre-wrap [overflow-wrap:anywhere] break-words">
              {stripLinePrefixNotice(props.m.output() || "").trim() ||
                String(props.m.mergedEnv()?.error || "Failed to write file.")}
            </div>
          }
        >
          <Show
            when={writeText().trim().length > 0}
            fallback={
              <div class="px-3 py-2 text-[11px] text-fg-muted">
                {!props.u.result
                  ? props.active
                    ? "Writing file…"
                    : "File write did not complete."
                  : String(props.m.mergedEnv()?.info || "Wrote empty file (0 bytes).")}
              </div>
            }
          >
            <CodeBlock
              embedded
              numbered
              follow={() => props.m.open() && props.running}
              text={writeText()}
              language={languageForPath(String(props.m.args().path || ""))}
              wrap={false}
              scrollKey={props.m.key()}
            />
          </Show>
        </Show>
      </Show>

      <Show when={props.m.name() === "exec_script" || props.m.name() === "python"}>
        {(() => {
          const isLegacyPy = () => {
            const a = props.m.args();
            const leg = typeof a.legacy_lang === "string" ? a.legacy_lang.trim().toLowerCase() : "";
            return (
              props.m.name() === "python" ||
              leg === "python" ||
              leg === "python3" ||
              (!String(a.code || "").trim() && Boolean(String(a.script || "").trim()))
            );
          };
          const scriptSource = () => {
            const code = String(props.m.args().code || "");
            if (code.trim()) return code;
            return [
              String(props.m.args().script || ""),
              ...(Array.isArray(props.m.args().args) ? props.m.args().args.map(String) : []),
            ]
              .filter(Boolean)
              .join(" ")
              .trim();
          };
          const execError = () =>
            String(props.m.mergedEnv()?.error || (props.u.result?.toolDetails as any)?.env?.error || "");
          const execOut = () =>
            props.m.bgRunning()
              ? props.m.bgStream() || props.m.prog() || ""
              : props.m.output() || props.m.prog() || execError();
          return (
            <>
              <Show when={scriptSource().length > 0}>
                <div class="border-b border-border-subtle bg-surface">
                  <CodeBlock
                    embedded
                    follow={() => props.m.open() && props.running}
                    text={scriptSource()}
                    language={isLegacyPy() ? "python" : "javascript"}
                    wrap={false}
                    maxH="max-h-40"
                    scrollKey={`${props.m.key()}:code`}
                  />
                </div>
              </Show>
              <Show
                when={execOut().trim().length > 0}
                fallback={
                  <div class={`px-3 py-2 text-2xs ${props.u.result?.isError ? "text-danger font-mono" : "text-fg-muted"}`}>
                    {props.m.bgRunning()
                      ? "Running in background…"
                      : !props.u.result
                        ? props.active
                          ? isLegacyPy()
                            ? "Running Python…"
                            : "Running JavaScript…"
                          : "Script execution did not complete."
                        : props.u.result.isError
                          ? "Script failed with no output."
                          : "No output."}
                  </div>
                }
              >
                <Show when={props.u.result?.toolDetails?.truncated || props.m.mergedEnv()?.truncated === "true"}>
                  <div class="px-3 py-1.5 bg-surface-subtle border-b border-border-subtle text-2xs text-fg-muted font-mono">
                    Output truncated (showing last {String(props.u.result?.toolDetails?.page || props.m.mergedEnv()?.page || "portion")})
                  </div>
                </Show>
                <CodeBlock
                  embedded
                  follow={() => props.m.open() && props.running}
                  text={props.m.bgRunning() ? props.m.bgStream() || props.m.prog() || "" : props.m.output() || props.m.prog() || execError()}
                  language={undefined}
                  plain
                  wrap={false}
                  scrollKey={`${props.m.key()}:out`}
                />
              </Show>
            </>
          );
        })()}
      </Show>
    </>
  );
}
