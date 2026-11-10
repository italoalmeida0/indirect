import { createEffect, createSignal, For, on, Show } from "solid-js";
import { DisclosureBody } from "./Disclosure";
import { Icon as Iconify } from "../../components/icon";
import { DiffView } from "./CodeBlock";
import { FileIcon } from "../presentation";
import type { TurnBalloon, TurnChangedFile } from "../hooks/useTurnChanges";

export interface TurnChangesBalloonProps {
  balloon: TurnBalloon;
  expanded: boolean;
  onToggle: () => void;
  undoBusy: boolean;
  onUndo: (path?: string) => void;
  live?: boolean;
  /** Refresh the live view on demand (visible only while the turn runs). */
  onReview?: () => void;
}

function statusMeta(status: TurnChangedFile["status"]) {
  switch (status) {
    case "new":
      return { icon: "lucide:file-plus", cls: "text-success" };
    case "modified":
      return { icon: "lucide:file-diff", cls: "text-warning" };
    case "deleted":
      return { icon: "lucide:file-minus", cls: "text-danger" };
    case "binary":
      return { icon: "lucide:file-exclamation-point", cls: "text-ink-400" };
    default:
      return { icon: "lucide:file-exclamation-point", cls: "text-ink-400" };
  }
}

/** One file row inside the balloon: collapsed header by default, click to
 *  reveal the highlighted diff (like edit tool results). */
function FileChangesRow(props: {
  f: TurnChangedFile;
  scrollKey: string;
  onUndo?: (path: string) => void;
  undoBusy?: boolean;
  live?: boolean;
}) {
  let rowRef: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const meta = () => statusMeta(props.f.status);
  const hasDiff = () => Boolean(props.f.diff);
  const isExpandable = () => hasDiff() || props.f.status === "binary";

  createEffect(
    on(
      open,
      (isOpen) => {
        if (isOpen) {
          requestAnimationFrame(() => {
            rowRef?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        }
      },
      { defer: true },
    ),
  );

  return (
    <div ref={rowRef} class="rounded-lg border border-border/70 overflow-hidden bg-surface/60">
      <div
        onClick={() => { if (isExpandable()) setOpen(!open()); }}
        class={`flex items-center gap-2 px-2.5 py-1.5 bg-surface-subtle/70 transition-colors select-none ${
          isExpandable() ? "cursor-pointer hover:bg-surface-muted/70" : ""
        }`}
      >
        <Show when={isExpandable()}>
          <Iconify
            icon="lucide:chevron-right"
            size={12}
            class={`shrink-0 text-fg-muted transition-transform ${open() ? "rotate-90" : ""}`}
          />
        </Show>
        <FileIcon path={props.f.rel || props.f.path} size={13} />
        <span class="text-[11px] font-mono text-fg truncate">
          {props.f.rel || props.f.path}
        </span>
        <span class={`text-[10px] flex items-center gap-1 shrink-0 ${meta().cls}`}>
          <Iconify icon={meta().icon} size={12} />
        </span>
        <Show when={(props.f.additions || 0) > 0 || (props.f.deletions || 0) > 0}>
          <span class="text-[10px] font-mono ml-auto shrink-0 tabular-nums">
            <span class="text-success">+{props.f.additions || 0}</span>{" "}
            <span class="text-danger">-{props.f.deletions || 0}</span>
          </span>
        </Show>
        <Show when={props.f.undone}>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-muted text-fg-secondary border border-border shrink-0">
            undone
          </span>
        </Show>
        <Show when={!props.live && !props.f.undone && props.onUndo}>
          <button
            type="button"
            disabled={props.undoBusy}
            onClick={(e) => {
              e.stopPropagation();
              props.onUndo!(props.f.path);
            }}
            class="text-[10px] px-2 py-0.5 rounded-md border border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50 shrink-0 ml-1.5 flex items-center gap-1"
            aria-label={`Undo changes to ${props.f.rel || props.f.path}`}
          >
            <Iconify icon="lucide:undo-2" size={11} />
            Undo
          </button>
        </Show>
      </div>
      <DisclosureBody open={open() && hasDiff()}>
        <div class="border-t border-border/60 bg-surface-subtle/30">
          <DiffView text={props.f.diff || ""} name={props.f.rel || props.f.path} scrollKey={props.scrollKey} />
        </div>
      </DisclosureBody>
      <DisclosureBody open={open() && !hasDiff()}>
        <div class="px-2.5 py-1.5 text-[11px] text-fg-muted border-t border-border/60">
          {props.f.status === "binary" ? "Binary file — no textual diff." : "File too large for a textual diff."}
        </div>
      </DisclosureBody>
    </div>
  );
}

export function TurnChangesBalloon(props: TurnChangesBalloonProps) {
  const files = () => props.balloon.files || [];
  const totalAdds = () => files().reduce((n, f) => n + (f.additions || 0), 0);
  const totalDels = () => files().reduce((n, f) => n + (f.deletions || 0), 0);
  const undoneCount = () => files().filter((f) => f.undone).length;

  return (
    <Show when={files().length > 0}>
      <div class="w-full flex justify-center my-3 select-text">
        <div class="rc-studio-card w-full max-w-2xl rounded-xl px-3.5 py-2.5 shadow-2xs transition-all">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            onClick={props.onToggle}
            class="flex items-center gap-2 cursor-pointer text-left group focus:outline-none"
          >
            <Iconify
              icon={props.expanded ? "lucide:chevron-down" : "lucide:chevron-right"}
              size={14}
              class="text-fg-muted group-hover:text-fg transition-colors"
            />
            <Iconify icon={props.live ? "lucide:loader-circle" : "lucide:files"} size={14} class={props.live ? "text-accent animate-spin" : "text-accent"} />
            <span class="text-xs font-medium text-fg">
              File changes
            </span>
            <span class="rounded-full border border-border/80 bg-surface-subtle px-2 py-0.5 text-[10px] font-medium text-fg-secondary tabular-nums">
              {files().length} file{files().length === 1 ? "" : "s"}
            </span>
            <Show when={totalAdds() > 0 || totalDels() > 0}>
              <span class="text-[11px] font-mono tabular-nums">
                <span class="text-success">+{totalAdds()}</span>{" "}
                <span class="text-danger">-{totalDels()}</span>
              </span>
            </Show>
            <Show when={!props.live && undoneCount() > 0}>
              <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface-muted text-fg-secondary border border-border">
                undone{undoneCount() < files().length ? " (partial)" : ""}
              </span>
            </Show>
          </button>
          <Show when={props.live && props.onReview}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onReview!();
              }}
              class="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:refresh-cw" size={12} />
              Refresh
            </button>
          </Show>
          <Show when={!props.live}>
            <button
              type="button"
              disabled={props.undoBusy || undoneCount() === files().length}
              onClick={(e) => {
                e.stopPropagation();
                if (undoneCount() === files().length) return;
                props.onUndo();
              }}
              class={`flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${
                undoneCount() === files().length
                  ? "text-fg-muted border-border/50 bg-surface-subtle/50 cursor-default opacity-60"
                  : "border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted cursor-pointer disabled:opacity-50"
              }`}
            >
              <Iconify icon={props.undoBusy ? "lucide:loader-circle" : "lucide:undo-2"} size={12} class={props.undoBusy ? "animate-spin" : ""} />
              {props.undoBusy ? "Undoing…" : undoneCount() === files().length ? "Undone" : "Undo"}
            </button>
          </Show>
        </div>

        <DisclosureBody open={props.expanded}>
          <div class="mt-2.5 pt-2.5 border-t border-border/60 flex flex-col gap-1.5">
            <For each={files()}>
              {(f) => (
                <FileChangesRow
                  f={f}
                  scrollKey={`turn-${props.balloon.turnIndex}:${f.path}`}
                  onUndo={(p) => props.onUndo(p)}
                  undoBusy={props.undoBusy}
                  live={props.live}
                />
              )}
            </For>
          </div>
        </DisclosureBody>
      </div>
    </div>
    </Show>
  );
}
