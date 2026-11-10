import { For, Show, createEffect } from "solid-js";
import { press } from "../../ds/motion/press";
import type { createMentions } from "../hooks/useMentions";
import { FloatMenu } from "./FloatMenu";
import { FileIcon } from "../presentation";

export function MentionMenu(props: {
  mentions: ReturnType<typeof createMentions>;
  inputId: string;
}) {
  let list: HTMLDivElement | undefined;
  createEffect(() => {
    const index = props.mentions.index();
    const options = list?.querySelectorAll("[role=option]");
    options?.[index]?.scrollIntoView({ block: "nearest" });
  });
  return (
    <FloatMenu
      anchor={() => document.getElementById(props.inputId)}
      open={props.mentions.open()}
      placement="top-start"
      width="min(28rem, calc(100vw - 1.5rem))"
    >
      <div class="px-2.5 py-1 text-[11px] font-medium text-fg-muted flex items-center justify-between">
        <span>Workspace files</span>
        <Show when={props.mentions.files().length > 0}>
          <span class="tabular-nums text-[10px] text-fg-muted">{props.mentions.files().length}</span>
        </Show>
      </div>
      <div
        ref={list}
        role="listbox"
        aria-label="File mentions"
        class="max-h-60 overflow-y-auto px-0.5 space-y-0.5"
      >
        <For each={props.mentions.files()}>
          {(path, i) => (
            <button
              role="option"
              aria-selected={i() === props.mentions.index()}
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => press(e.currentTarget)}
              onClick={() => props.mentions.pick(path)}
              class={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                i() === props.mentions.index()
                  ? "bg-accent-subtle text-fg font-medium"
                  : "hover:bg-surface-muted text-fg-secondary hover:text-fg"
              }`}
            >
              <FileIcon path={path} size={14} />
              <span class="truncate">{path}</span>
            </button>
          )}
        </For>
        <Show when={!props.mentions.files().length}>
          <p class="px-2.5 py-2.5 text-xs text-fg-muted">
            {props.mentions.loading()
              ? "Searching files..."
              : props.mentions.error() || "No matching files"}
          </p>
        </Show>
      </div>
    </FloatMenu>
  );
}
