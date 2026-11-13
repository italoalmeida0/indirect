import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { createShimmerStyle } from "../../ds/motion/shimmer";
import { DisclosureBody } from "./Disclosure";
import { Icon as Iconify } from "../../components/icon";
import { DiffView } from "./CodeBlock";
import { FileIcon } from "../presentation";
import { diffStatBlocks, type TurnBalloon, type TurnChangedFile } from "../hooks/useTurnChanges";

export interface TurnChangesBalloonProps {
  balloon: TurnBalloon;
  expanded: boolean;
  onToggle: () => void;
  live?: boolean;
  /** Refresh the live view on demand (visible only while the turn runs). */
  onReview?: () => void;
}

function statusMeta(status: TurnChangedFile["status"]) {
  switch (status) {
    case "new":
      return { label: "A", title: "Added", cls: "text-success bg-success-subtle border-border-subtle" };
    case "modified":
      return { label: "M", title: "Modified", cls: "text-warning bg-warning-subtle border-border-subtle" };
    case "deleted":
      return { label: "D", title: "Deleted", cls: "text-danger bg-danger-subtle border-border-subtle" };
    case "binary":
      return { label: "BIN", title: "Binary file", cls: "text-fg-muted bg-surface-muted border-border" };
    default:
      return { label: "LRG", title: "Too large to diff", cls: "text-fg-muted bg-surface-muted border-border" };
  }
}

function splitDisplayPath(raw: string): { dir: string; base: string } {
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  if (slash < 0) return { dir: "", base: raw };
  return { dir: raw.slice(0, slash + 1), base: raw.slice(slash + 1) };
}

function fileRowKey(f: TurnChangedFile): string {
  const keyed = f as TurnChangedFile & { id?: string };
  return typeof keyed.id === "string" && keyed.id ? keyed.id : f.path;
}

/** One file row inside the balloon: collapsed header by default, click to
 *  reveal the highlighted diff (like edit tool results). */
function FileChangesRow(props: {
  f: TurnChangedFile;
  scrollKey: string;
  open: boolean;
  manualScroll: boolean;
  onToggle: () => void;
}) {
  let rowRef: HTMLDivElement | undefined;
  const meta = () => statusMeta(props.f.status);
  const hasDiff = () => Boolean(props.f.diff);
  const isExpandable = () => hasDiff() || props.f.status === "binary";
  const displayPath = () => props.f.rel || props.f.path;
  const parts = () => splitDisplayPath(displayPath());

  createEffect(
    on(
      () => props.open,
      (isOpen) => {
        if (isOpen && props.manualScroll) {
          requestAnimationFrame(() => {
            rowRef?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        }
      },
      { defer: true },
    ),
  );

  const rowInner = () => (
    <>
      <Show when={isExpandable()}>
        <Iconify
          icon="lucide:chevron-right"
          size={12}
          class={`shrink-0 text-fg-muted transition-transform duration-150 ${props.open ? "rotate-90" : ""}`}
        />
      </Show>
      <Show when={!isExpandable()}>
        <span class="w-3 shrink-0" aria-hidden="true" />
      </Show>
      <FileIcon path={displayPath()} size={13} />
      <span class="text-xs font-mono flex items-baseline min-w-0 flex-1" data-rc-tip={displayPath()}>
        <Show when={parts().dir}>
          <span class="text-fg-muted min-w-0 shrink truncate">{parts().dir}</span>
        </Show>
        <span class="text-fg font-medium shrink-0 truncate max-w-[70%]">{parts().base}</span>
      </span>
      <span
        data-rc-tip={meta().title}
        class={`inline-flex items-center justify-center rounded-xs px-1 py-px text-2xs leading-tight font-mono font-medium border shrink-0 ${meta().cls}`}
      >
        {meta().label}
      </span>
      <Show when={(props.f.additions || 0) > 0 || (props.f.deletions || 0) > 0}>
        <span class="text-2xs font-mono ml-auto shrink-0 tabular-nums flex items-center gap-1.5">
          <span class="text-success">+{props.f.additions || 0}</span>
          <span class="text-danger">-{props.f.deletions || 0}</span>
        </span>
      </Show>
    </>
  );

  return (
    <div ref={rowRef} class="overflow-hidden border-t border-border-subtle first:border-t-0">
      <Show when={isExpandable()}>
        <button
          type="button"
          aria-expanded={props.open}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => props.onToggle()}
          class="w-full flex items-center gap-2 min-h-8 [@media(pointer:coarse)]:min-h-11 px-3.5 py-1.5 text-left transition-colors cursor-pointer hover:bg-surface-muted/60"
        >
          {rowInner()}
        </button>
      </Show>
      <Show when={!isExpandable()}>
        <div class="w-full flex items-center gap-2 min-h-8 px-3.5 py-1.5 select-none">
          {rowInner()}
        </div>
      </Show>
      <DisclosureBody open={props.open && hasDiff()}>
        <div class="border-t border-border-subtle bg-surface">
          <DiffView text={props.f.diff || ""} name={displayPath()} scrollKey={props.scrollKey} />
        </div>
      </DisclosureBody>
      <DisclosureBody open={props.open && !hasDiff()}>
        <div class="px-3.5 py-2 text-2xs text-fg-muted border-t border-border-subtle bg-surface-subtle">
          {props.f.status === "binary" ? "Binary file · no textual diff." : "File too large for a textual diff."}
        </div>
      </DisclosureBody>
    </div>
  );
}

export function TurnChangesBalloon(props: TurnChangesBalloonProps) {
  const [openMap, setOpenMap] = createSignal<Record<string, boolean>>({});
  const [manualKey, setManualKey] = createSignal<string | null>(null);

  const files = () => props.balloon.files || [];
  const totalAdds = () => files().reduce((n, f) => n + (f.additions || 0), 0);
  const totalDels = () => files().reduce((n, f) => n + (f.deletions || 0), 0);
  const liveShimmerStyle = createShimmerStyle(() => Boolean(props.live));

  const statCells = createMemo(() => diffStatBlocks(totalAdds(), totalDels()));
  const expandableKeys = createMemo(() =>
    files()
      .filter((f) => Boolean(f.diff) || f.status === "binary")
      .map((f) => fileRowKey(f)),
  );
  const allExpanded = createMemo(() => {
    const keys = expandableKeys();
    const map = openMap();
    return keys.length > 0 && keys.every((k) => Boolean(map[k]));
  });

  function toggleRow(key: string) {
    setManualKey(key);
    setOpenMap((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  function toggleExpandAll() {
    const nextOpen = !allExpanded();
    setManualKey(null);
    setOpenMap((prev) => {
      const next = { ...prev };
      for (const k of expandableKeys()) next[k] = nextOpen;
      return next;
    });
  }

  return (
    <Show when={files().length > 0}>
      <div class="w-full select-text">
        <div data-turn-changes class="w-full rounded-panel border border-border bg-surface-subtle overflow-hidden transition-colors">
          <div class="flex items-stretch justify-between">
            <button
              type="button"
              aria-expanded={props.expanded}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={props.onToggle}
              class="group flex flex-1 items-center gap-2 min-h-9 [@media(pointer:coarse)]:min-h-11 px-3.5 py-2 cursor-pointer text-left hover:bg-surface-muted/60 transition-colors min-w-0"
            >
              <Iconify
                icon="lucide:chevron-right"
                size={13}
                class={`text-fg-muted group-hover:text-fg transition-transform duration-150 shrink-0 ${props.expanded ? "rotate-90" : ""}`}
              />
              <Show when={props.live}>
                <Iconify icon="lucide:file-diff" size={13} class="text-fg-muted shrink-0" />
              </Show>
              <span class={`text-xs font-medium tabular-nums truncate ${props.live ? "ui-shimmer text-fg-secondary" : "text-fg"}`} style={liveShimmerStyle()}>
                {files().length} {files().length === 1 ? "file" : "files"} changed
              </span>
              <Show when={totalAdds() > 0 || totalDels() > 0}>
                <span class="text-2xs font-mono tabular-nums flex items-center gap-1.5 shrink-0">
                  <span class="text-success">+{totalAdds()}</span>
                  <span class="text-danger">-{totalDels()}</span>
                </span>
                <span class="hidden min-[380px]:inline-flex items-center gap-[2px] ml-0.5 shrink-0" aria-hidden="true">
                  <For each={statCells()}>
                    {(cell) => (
                      <span
                        class={`h-1.5 w-1.5 rounded-[1.5px] ${
                          cell === "add" ? "bg-success" : cell === "del" ? "bg-danger" : "bg-border"
                        }`}
                      />
                    )}
                  </For>
                </span>
              </Show>
            </button>

            <Show when={(props.expanded && files().length > 1 && expandableKeys().length > 0) || (props.live && props.onReview)}>
              <div class="flex items-center gap-1 pr-2.5 shrink-0">
                <Show when={props.expanded && files().length > 1 && expandableKeys().length > 0}>
                  <button
                    type="button"
                    onPointerDown={(e) => press(e.currentTarget)}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpandAll();
                    }}
                    data-rc-tip={allExpanded() ? "Collapse all file diffs" : "Expand all file diffs"}
                    class="flex items-center gap-1 min-h-7 [@media(pointer:coarse)]:min-h-11 text-2xs px-2 py-1 rounded-inner text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <Iconify icon={allExpanded() ? "lucide:chevrons-down-up" : "lucide:chevrons-up-down"} size={11} />
                    <span>{allExpanded() ? "Collapse all" : "Expand all"}</span>
                  </button>
                </Show>
                <Show when={props.live && props.onReview}>
                  <button
                    type="button"
                    onPointerDown={(e) => press(e.currentTarget)}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onReview!();
                    }}
                    data-rc-tip="Refresh file changes"
                    class="flex items-center gap-1 min-h-7 [@media(pointer:coarse)]:min-h-11 text-2xs px-2 py-1 rounded-inner text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:refresh-cw" size={11} />
                    <span>Refresh</span>
                  </button>
                </Show>
              </div>
            </Show>
          </div>

          <DisclosureBody open={props.expanded}>
            <div class="border-t border-border bg-surface flex flex-col">
              <For each={files()}>
                {(f) => {
                  const key = () => fileRowKey(f);
                  return (
                    <FileChangesRow
                      f={f}
                      scrollKey={`turn-${props.balloon.turnIndex}:${key()}`}
                      open={Boolean(openMap()[key()])}
                      manualScroll={manualKey() === key()}
                      onToggle={() => toggleRow(key())}
                    />
                  );
                }}
              </For>
            </div>
          </DisclosureBody>
        </div>
      </div>
    </Show>
  );
}
