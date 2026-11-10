import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
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
      return { label: "A", title: "Added", cls: "text-success bg-success-subtle border-success/25" };
    case "modified":
      return { label: "M", title: "Modified", cls: "text-warning bg-warning-subtle border-warning/25" };
    case "deleted":
      return { label: "D", title: "Deleted", cls: "text-danger bg-danger-subtle border-danger/25" };
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

  return (
    <div ref={rowRef} class="overflow-hidden border-t border-border/55 first:border-t-0">
      <div
        role={isExpandable() ? "button" : undefined}
        tabIndex={isExpandable() ? 0 : undefined}
        aria-expanded={isExpandable() ? props.open : undefined}
        onClick={() => {
          if (isExpandable()) props.onToggle();
        }}
        onKeyDown={(e) => {
          if (!isExpandable()) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggle();
          }
        }}
        class={`flex items-center gap-2 px-3 py-1.5 transition-colors select-none ${
          isExpandable() ? "cursor-pointer hover:bg-surface-muted/55" : ""
        }`}
      >
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
        <span class="text-[11.5px] font-mono truncate min-w-0">
          <Show when={parts().dir}>
            <span class="text-fg-muted">{parts().dir}</span>
          </Show>
          <span class="text-fg font-medium">{parts().base}</span>
        </span>
        <span
          title={meta().title}
          class={`inline-flex items-center justify-center rounded px-1 py-px text-[9.5px] leading-tight font-mono font-medium border shrink-0 ${meta().cls}`}
        >
          {meta().label}
        </span>
        <Show when={(props.f.additions || 0) > 0 || (props.f.deletions || 0) > 0}>
          <span class="text-[11px] font-mono ml-auto shrink-0 tabular-nums flex items-center gap-1.5">
            <span class="text-success">+{props.f.additions || 0}</span>
            <span class="text-danger">-{props.f.deletions || 0}</span>
          </span>
        </Show>
      </div>
      <DisclosureBody open={props.open && hasDiff()}>
        <div class="border-t border-border/50 bg-surface">
          <DiffView text={props.f.diff || ""} name={displayPath()} scrollKey={props.scrollKey} />
        </div>
      </DisclosureBody>
      <DisclosureBody open={props.open && !hasDiff()}>
        <div class="px-3 py-1.5 text-[11px] text-fg-muted border-t border-border/50 bg-surface-subtle/50">
          {props.f.status === "binary" ? "Binary file — no textual diff." : "File too large for a textual diff."}
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
      <div class="w-full my-2 select-text">
        <div class="w-full rounded-xl border border-border/80 bg-surface-subtle/65 overflow-hidden transition-colors">
          <div class="flex items-center justify-between gap-2 px-3 py-2 flex-wrap">
            <button
              type="button"
              aria-expanded={props.expanded}
              onClick={props.onToggle}
              class="flex items-center gap-2 cursor-pointer text-left group focus:outline-none min-w-0"
            >
              <Iconify
                icon="lucide:chevron-right"
                size={13}
                class={`text-fg-muted group-hover:text-fg transition-transform duration-150 shrink-0 ${props.expanded ? "rotate-90" : ""}`}
              />
              <Show when={props.live}>
                <Iconify icon="lucide:loader-circle" size={13} class="text-fg-muted animate-spin shrink-0" />
              </Show>
              <span class="text-xs font-medium text-fg">
                {files().length} {files().length === 1 ? "file" : "files"} changed
              </span>
              <Show when={totalAdds() > 0 || totalDels() > 0}>
                <span class="text-[11px] font-mono tabular-nums flex items-center gap-1.5">
                  <span class="text-success">+{totalAdds()}</span>
                  <span class="text-danger">-{totalDels()}</span>
                </span>
                <span class="inline-flex items-center gap-[2px] ml-0.5 shrink-0" aria-hidden="true">
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
              <div class="flex items-center gap-1 ml-auto shrink-0">
                <Show when={props.expanded && files().length > 1 && expandableKeys().length > 0}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpandAll();
                    }}
                    class="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <Iconify icon={allExpanded() ? "lucide:chevrons-down-up" : "lucide:chevrons-up-down"} size={11} />
                    {allExpanded() ? "Collapse all" : "Expand all"}
                  </button>
                </Show>
                <Show when={props.live && props.onReview}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onReview!();
                    }}
                    class="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <Iconify icon="lucide:refresh-cw" size={11} />
                    Refresh
                  </button>
                </Show>
              </div>
            </Show>
          </div>

          <DisclosureBody open={props.expanded}>
            <div class="border-t border-border/60 bg-surface/50 flex flex-col">
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
