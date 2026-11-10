import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock, DiffView } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { languageForPath } from "../../utils/lang";
import { parseEditResults } from "../../utils/toolEdits";
import type { FileEditSection } from "../../utils/toolEdits";
import { diffStat } from "../../transcript";
import type { ToolPartProps } from "./toolUnitModel";

function FileEditCard(props: { sec: FileEditSection; scrollKey?: string }) {
  const [open, setOpen] = createSignal(true);
  const stat = () => diffStat(props.sec.diff);

  return (
    <div class="border-b border-border/60 last:border-b-0">
      <div
        onClick={() => setOpen(!open())}
        class="group/file flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-subtle/70 hover:bg-surface-muted/70 text-[12px] cursor-pointer transition-colors select-none"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <FileIcon path={props.sec.file} size={14} />
          <span class="font-mono font-medium text-fg truncate">{props.sec.file || "edit"}</span>
          <Show when={props.sec.status === "error"}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-danger-subtle text-danger font-mono">
              failed
            </span>
          </Show>
          <Show when={props.sec.status === "dry_run"}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-warning-subtle text-warning font-mono">
              preview
            </span>
          </Show>
          <Show when={stat().add > 0 || stat().del > 0}>
            <span class="font-mono text-[10.5px] shrink-0 tabular-nums">
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
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-muted text-fg-secondary font-mono">
              {props.sec.matches} {props.sec.matches === 1 ? "match" : "matches"}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Iconify
            icon="lucide:chevron-down"
            size={12}
            class={`text-fg-muted transition-transform ${open() ? "rotate-180" : ""}`}
          />
        </div>
      </div>
      <Show when={open()}>
        <Show when={props.sec.error}>
          <div class="px-3 py-2 text-[11.5px] text-danger font-mono bg-danger-subtle border-t border-danger/20">
            {props.sec.error}
          </div>
        </Show>
        <Show when={props.sec.diff}>
          <div class="border-t border-border/50">
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
    if (a.id && (props.m.name() === "widget_edit" || props.m.name() === "widget_read" || props.m.name() === "widget_set")) return String(a.id);
    if (Array.isArray(a.edits) && a.edits.length === 1) {
      return String(a.edits[0]?.path || a.edits[0]?.file || "");
    }
    return "";
  };

  const sections = createMemo(() => {
    // The daemon now sends the rich rendering in details.display (the
    // AI-visible text is a one-line confirmation); fall back to parsing
    // the result text for sessions recorded before the split.
    const res = (props.u.result?.toolDetails?.display ?? props.m.output()) || "";
    return parseEditResults(res, defaultPath());
  });

  return (
    <>
      {/* Context body per tool kind (scrollable, always inline — the
          collapsible rows already are the "open file/diff" view). */}
      <Show when={(props.m.name() === "edit" || props.m.name() === "patch" || props.m.name() === "widget_edit") && props.u.result}>
        <Show when={props.u.result?.toolDetails?.dry_run === true}>
          <div class="px-3 pt-2 pb-1">
            <span class="inline-flex items-center gap-1.5 rounded-lg border border-warning/35 bg-warning-subtle px-2 py-1 text-[11px] text-warning">
              <Iconify icon="lucide:eye" size={12} /> Dry run · no files written
            </span>
          </div>
        </Show>
        <Show
          when={sections().length > 0}
          fallback={
            <div class="px-3 py-2 text-[11px] text-fg-muted">
              No changes
            </div>
          }
        >
          <For each={sections()}>
            {(sec) => <FileEditCard sec={sec} scrollKey={`${props.m.key()}:${sec.file}`} />}
          </For>
        </Show>
      </Show>
        <Show when={(props.m.name() === "edit" || props.m.name() === "patch" || props.m.name() === "widget_edit") && !props.u.result}>
          <Show when={props.u.result?.toolDetails?.dry_run === true}>
            <div class="px-3 pt-2 pb-1">
              <span class="inline-flex items-center gap-1.5 rounded-lg border border-warning/35 bg-warning-subtle px-2 py-1 text-[11px] text-warning">
                <Iconify icon="lucide:eye" size={12} /> Dry run · no files written
              </span>
            </div>
          </Show>
          <div class="px-3 py-2 text-[11px] text-fg-muted">
            {props.active ? (props.u.result?.toolDetails?.dry_run === true ? "Previewing edit…" : "Applying edit…") : null}
          </div>
        </Show>
        <Show when={props.m.name() === "read" || props.m.name() === "widget_read"}>
          <Show
            when={props.u.result?.toolDetails?.display || props.m.output() || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.active ? "Reading file…" : null}</div>}
          >
            <CodeBlock embedded numbered
              follow={() => props.m.open() && props.running}
              text={(props.u.result?.toolDetails?.display ?? props.m.output()) || props.m.prog() || ""}
              language={languageForPath(String(props.m.args().path || props.m.args().id || "")) || (props.m.name() === "widget_read" ? "tsx" : undefined)}
              wrap={false}
              scrollKey={props.m.key()}
            />
          </Show>
        </Show>
        <Show when={props.m.name() === "write" || props.m.name() === "widget_set"}>
          <CodeBlock embedded numbered
            follow={() => props.m.open() && props.running}
            text={String((props.u.result?.toolDetails?.display ?? props.m.output()) || props.m.args().content || "")}
            language={languageForPath(String(props.m.args().path || props.m.args().id || "")) || (props.m.name() === "widget_set" ? "tsx" : undefined)}
            wrap={false}
            scrollKey={props.m.key()}
          />
        </Show>
        <Show when={props.m.name() === "exec_script" || props.m.name() === "python"}>
          {(() => {
            const isLegacyPy = () => {
              const a = props.m.args();
              const leg = typeof a.legacy_lang === "string" ? a.legacy_lang.trim().toLowerCase() : "";
              return props.m.name() === "python" || leg === "python" || leg === "python3" || (!String(a.code || "").trim() && Boolean(String(a.script || "").trim()));
            };
            return (
              <>
                <Show when={props.m.args().code || props.m.args().script}>
                  <div class="border-b border-border/60 bg-surface/50">
                    <CodeBlock
                      embedded
                      follow={() => props.m.open() && props.running}
                      text={
                        String(props.m.args().code || "").trim()
                          ? String(props.m.args().code)
                          : [String(props.m.args().script || ""), ...(Array.isArray(props.m.args().args) ? props.m.args().args.map(String) : [])].filter(Boolean).join(" ")
                      }
                      language={isLegacyPy() ? "python" : "javascript"}
                      wrap={false}
                      maxH="max-h-40"
                      scrollKey={`${props.m.key()}:code`}
                    />
                  </div>
                </Show>
                <Show
                  when={props.m.output() || props.m.prog() || props.m.bgRunning() || props.m.bgStream() || (props.u.result?.toolDetails as any)?.env?.error}
                  fallback={<div class="px-3 py-2 text-[11px] text-fg-muted">{props.m.bgRunning() ? "Running in background…" : props.active ? (isLegacyPy() ? "Running Python…" : "Running JavaScript…") : null}</div>}
                >
                  <Show when={props.u.result?.toolDetails?.truncated}>
                    <div class="px-3 py-1 bg-surface-muted/65 border-b border-border/55 text-[10.5px] text-fg-muted font-mono">
                      Output truncated (showing last {String(props.u.result?.toolDetails?.page || "portion")})
                    </div>
                  </Show>
                  <CodeBlock embedded follow={() => props.m.open() && props.running} text={props.m.bgRunning() ? (props.m.bgStream() || props.m.prog() || "Running in background…") : props.m.output() || props.m.prog() || String((props.u.result?.toolDetails as any)?.env?.error || "No output")} language={undefined} plain wrap={false} scrollKey={`${props.m.key()}:out`} />
                </Show>
              </>
            );
          })()}
        </Show>
</>
  );
}
