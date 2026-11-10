import { createEffect, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { MentionMenu } from "../MentionMenu";
import { FileIcon } from "../../presentation";

export function ComposerInput() {
  const c = useComposerCtx();
  const s = useSession();
  const m = useModal();
  const ui = useUI();
  let textareaRef: HTMLTextAreaElement | undefined;
  const [dragActive, setDragActive] = createSignal(false);

  createEffect(() => {
    const text = c.inputPrompt();
    if (!textareaRef) return;
    if (!text) {
      textareaRef.style.height = "";
    } else {
      if (textareaRef.value !== text) {
        textareaRef.value = text;
      }
      textareaRef.style.height = "auto";
      textareaRef.style.height = Math.min(textareaRef.scrollHeight, 160) + "px";
    }
  });

  return (
<>
<MentionMenu mentions={c.mentions} inputId="rc-composer" />
<Show when={dragActive()}>
  <div class="mx-3 mt-2.5 flex items-center justify-center gap-2 rounded-lg border border-dashed border-accent bg-accent-subtle px-3 py-2 text-xs font-medium text-accent pointer-events-none">
    <Iconify icon="lucide:upload-cloud" size={14} />
    <span>Drop files to attach to prompt</span>
  </div>
</Show>
<Show when={c.preparingAttachments() > 0}>
  <p role="status" class="px-3.5 pt-2.5 flex items-center gap-1.5 text-xs text-fg-muted">
    <Iconify icon="lucide:loader-2" size={12} class="animate-spin text-accent" />
    <span>Preparing {c.preparingAttachments()} file(s)...</span>
  </p>
</Show>
{/* Attachment chips */}
<Show when={c.pendingAttachments().length > 0}>
  <div class="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
    <For each={c.pendingAttachments()}>
      {(att) => (
        <div
          role="button"
          tabIndex={0}
          onClick={() => m.previewPending(att)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              m.previewPending(att);
            }
          }}
          aria-label={`Preview ${att.name}`}
          class="group flex items-center gap-1.5 bg-surface-subtle rounded-md border border-border pl-2 pr-1 py-1 text-xs max-w-[220px] cursor-pointer hover:border-border-strong hover:bg-surface-muted transition-colors"
          data-rc-tip={`${att.name} (${Math.max(1, Math.round(att.size / 1024))}KB) — click to preview`}
        >
          <Show
            when={att.loading}
            fallback={<FileIcon path={att.name} size={15} />}
          >
            <span class="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
          </Show>
          <span class="truncate text-fg font-medium">{att.name}</span>
          <span class="shrink-0 font-mono text-[10px] text-fg-muted tabular-nums">
            {Math.max(1, Math.round(att.size / 1024))}K
          </span>
          <Show when={att.uploading}>
            <span class="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
          </Show>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              c.removePendingAttachment(att.key);
            }}
            class="shrink-0 flex h-4 w-4 items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors cursor-pointer"
            disabled={c.sending()}
            data-rc-tip="Remove" aria-label="Remove"
          >
            <Iconify icon="lucide:x" size={11} />
          </button>
        </div>
      )}
    </For>
  </div>
</Show>

{/* Input row: textarea occupies remaining width, clear button takes its own size */}
<div
  class="flex items-start"
  onDragEnter={(e) => {
    if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
  }}
  onDragLeave={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  }}
>
  <textarea
    id="rc-composer"
    ref={textareaRef}
    disabled={s.creatingSession() || c.sending()}
    rows={1}
    class="flex-1 min-w-0 bg-transparent text-[13px] leading-relaxed text-fg placeholder:text-fg-muted focus:outline-none resize-none px-3.5 pt-3 pb-2 max-h-[160px] min-h-[56px] overflow-y-auto [scrollbar-gutter:stable]"
    placeholder="Ask anything, @ to mention, / for actions"
    value={c.inputPrompt()}
    onFocus={() => c.mentions.setFocused(true)}
    onBlur={() => { c.mentions.setFocused(false); }}
    onSelect={(e) => c.mentions.setCaret(e.currentTarget.selectionStart)}
    onClick={(e) => c.mentions.setCaret(e.currentTarget.selectionStart)}
    onKeyUp={(e) => c.mentions.setCaret(e.currentTarget.selectionStart)}
    onInput={(e) => {
      c.setInputPrompt(e.currentTarget.value);
      c.mentions.setCaret(e.currentTarget.selectionStart);
      const el = e.currentTarget;
      if (!el.value) {
        el.style.height = "";
      } else {
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 160) + "px";
      }
    }}
    onPaste={(e) => {
      const files: File[] = [];
      try {
        const items = e.clipboardData?.items;
        if (items) {
          for (const it of items) {
            if (it.kind === "file") {
              const f = it.getAsFile();
              if (f) files.push(f);
            }
          }
        }
      } catch {}
      if (files.length > 0) {
        e.preventDefault();
        c.handleFiles(files);
      }
    }}
    onDragOver={(e) => {
      e.preventDefault();
      if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
    }}
    onDrop={(e) => {
      e.preventDefault();
      setDragActive(false);
      try {
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length > 0) c.handleFiles(files);
      } catch {}
    }}
    onKeyDown={(e) => {
      if (e.isComposing) return;
      if (c.mentions.keyDown(e)) return;
      if (c.slashMatches().length > 0) {
        if (e.key === "Escape") { e.preventDefault(); c.dismissSlash(); return; }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          c.setSlashIndex((prev) =>
            Math.min(prev + 1, c.slashMatches().length - 1),
          );
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          c.setSlashIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
          e.preventDefault();
          const pick = c.slashMatches()[c.slashIndex()];
          if (pick) c.pickSlash(pick.cmd);
          return;
        }
      }

      // On desktop, Enter sends the message (Shift+Enter for newline).
      // On mobile, plain Enter never sends — it inserts a line break and the
      // user taps send. Ctrl/Cmd+Enter still sends so a hardware keyboard
      // (iPad, Android tablet, phone with a keyboard) keeps the shortcut.
      if (
        e.key === "Enter" &&
        !e.shiftKey &&
        (!ui.isMobile() || e.ctrlKey || e.metaKey)
      ) {
        e.preventDefault();
        if (textareaRef) textareaRef.style.height = "";
        c.sendPrompt();
      }
    }}
  />
  <Show when={c.inputPrompt().length > 0}>
    <button
      type="button"
      onClick={() => {
        c.setInputPrompt("");
        if (textareaRef) textareaRef.style.height = "";
      }}
      class="shrink-0 mr-2.5 mt-2.5 p-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
      data-rc-tip="Clear input" aria-label="Clear input"
    >
      <Iconify icon="lucide:x" size={13} />
    </button>
  </Show>
</div>
</>
  );
}
