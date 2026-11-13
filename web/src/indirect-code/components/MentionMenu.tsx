import { For, Show, createEffect } from "solid-js";
import { press } from "../../ds/motion/press";
import type { createMentions } from "../hooks/useMentions";
import { FloatMenu } from "./FloatMenu";
import { FileIcon } from "../presentation";

function splitFilePath(path: string): { dir: string; base: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return { dir: "", base: path };
  return { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

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
      onClose={() => props.mentions.dismiss()}
      placement="top-start"
      width="min(28rem, calc(100vw - 1.5rem))"
    >
      <div class="-mx-1.5 -mt-1.5 mb-1.5 px-3 py-1.5 border-b border-border-subtle text-2xs font-medium text-fg-muted flex items-center justify-between">
        <span>Workspace files</span>
        <Show when={props.mentions.files().length > 0}>
          <span class="font-mono tabular-nums text-2xs text-fg-muted">{props.mentions.files().length}</span>
        </Show>
      </div>
      <div
        ref={list}
        role="listbox"
        aria-label="File mentions"
        class="max-h-60 overflow-y-auto overscroll-contain space-y-0.5"
      >
        <For each={props.mentions.files()}>
          {(path, i) => {
            const parts = splitFilePath(path);
            const active = () => i() === props.mentions.index();
            return (
              <button
                type="button"
                role="option"
                aria-label={path}
                aria-selected={active()}
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => props.mentions.pick(path)}
                class={`ui-menu-item w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors ${
                  active()
                    ? "bg-accent-subtle text-fg"
                    : "hover:bg-surface-muted text-fg-secondary hover:text-fg"
                }`}
              >
                <FileIcon path={path} size={14} />
                <span class="truncate min-w-0">
                  <Show when={parts.dir}>
                    <span class="text-fg-muted">{parts.dir}</span>
                  </Show>
                  <span class={active() ? "font-medium text-fg" : "text-fg"}>{parts.base}</span>
                </span>
              </button>
            );
          }}
        </For>
        <Show when={!props.mentions.files().length}>
          <p class="px-2.5 py-2.5 text-xs text-fg-muted">
            {props.mentions.loading()
              ? "Searching files…"
              : props.mentions.error() || "No matching files"}
          </p>
        </Show>
      </div>
    </FloatMenu>
  );
}
