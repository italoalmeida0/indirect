import { batch, createEffect, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { MentionMenu } from "../MentionMenu";
import { FileIcon } from "../../presentation";

export function syncComposerHeight(el: HTMLTextAreaElement, text: string) {
  if (!text) {
    el.style.height = "";
    el.style.overflowY = "hidden";
    return;
  }
  const h = el.style.height;
  if (
    !text.includes("\n") &&
    (h === "" || h === "36px") &&
    el.scrollWidth <= el.clientWidth &&
    (el.clientWidth === 0 || text.length * 7 <= el.clientWidth)
  ) {
    return;
  }
  el.style.height = "auto";
  const sh = el.scrollHeight;
  el.style.height = Math.min(sh, 160) + "px";
  el.style.overflowY = sh > 160 ? "auto" : "hidden";
}

export function ComposerInput() {
  const c = useComposerCtx();
  const s = useSession();
  const m = useModal();
  const ui = useUI();
  let textareaRef: HTMLTextAreaElement | undefined;
  let inputUpdatedCaret = false;
  const [dragActive, setDragActive] = createSignal(false);

  createEffect(() => {
    const text = c.inputPrompt();
    if (!textareaRef) return;
    if (textareaRef.value !== text) {
      textareaRef.value = text;
    }
    syncComposerHeight(textareaRef, text);
  });

  return (
<>
<MentionMenu mentions={c.mentions} inputId="rc-composer" />
<Show when={dragActive()}>
  <div class="mx-3 mt-3 flex items-center justify-center gap-2 rounded-inner border border-dashed border-accent bg-accent-subtle px-3 py-2 text-xs font-medium text-accent pointer-events-none">
    <Iconify icon="lucide:upload-cloud" size={14} />
    <span>Drop files to attach to prompt</span>
  </div>
</Show>
<Show when={c.preparingAttachments() > 0}>
  <p role="status" class="px-3.5 pt-3 flex items-center gap-1.5 text-xs text-fg-muted">
    <span class="ui-spinner text-accent shrink-0" aria-hidden="true" />
    <span>Preparing {c.preparingAttachments()} file(s)…</span>
  </p>
</Show>
{/* Attachment chips */}
<Show when={c.pendingAttachments().length > 0}>
  <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
    <For each={c.pendingAttachments()}>
      {(att) => (
        <div
          class="group inline-flex items-center bg-surface-subtle rounded-inner border border-border max-w-[220px] text-xs hover:border-border-strong hover:bg-surface-muted transition-colors"
        >
          <button
            type="button"
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
            data-rc-tip={`${att.name} (${Math.max(1, Math.round(att.size / 1024))}KB) · click to preview`}
            class="flex min-w-0 items-center gap-1.5 pl-2 pr-1 py-1 text-left cursor-pointer"
          >
            <Show
              when={att.loading}
              fallback={<FileIcon path={att.name} size={15} />}
            >
              <span class="ui-spinner text-accent shrink-0" aria-hidden="true" />
            </Show>
            <span class="truncate text-fg font-medium">{att.name}</span>
            <span class="shrink-0 font-mono text-2xs text-fg-muted tabular-nums">
              {Math.max(1, Math.round(att.size / 1024))}K
            </span>
            <Show when={att.uploading}>
              <span class="ui-spinner text-accent shrink-0" aria-hidden="true" />
            </Show>
          </button>
          <button
            type="button"
            onClick={() => {
              c.removePendingAttachment(att.key);
            }}
            class="relative shrink-0 mr-1 flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors cursor-pointer [@media(pointer:coarse)]:after:content-[''] [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:inset-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-11 [@media(pointer:coarse)]:after:-translate-1/2"
            disabled={c.sending()}
            data-rc-tip="Remove attachment" aria-label={`Remove ${att.name}`}
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
    class="flex-1 min-w-0 bg-transparent text-sm max-sm:text-base leading-[20px] text-fg placeholder:text-fg-muted focus:outline-none resize-none px-3.5 pt-3 pb-1 max-h-[160px] min-h-9 overflow-y-hidden"
    placeholder={ui.isMobile() ? "Ask anything · @ files · / actions" : "Ask anything, @ to mention, / for actions"}
    value={c.inputPrompt()}
    onFocus={() => c.mentions.setFocused(true)}
    onBlur={() => { c.mentions.setFocused(false); }}
    onSelect={(e) => c.mentions.setCaret(e.currentTarget.selectionStart)}
    onClick={(e) => c.mentions.setCaret(e.currentTarget.selectionStart)}
    onKeyUp={(e) => {
      if (inputUpdatedCaret) {
        inputUpdatedCaret = false;
        return;
      }
      c.mentions.setCaret(e.currentTarget.selectionStart);
    }}
    onInput={(e) => {
      const el = e.currentTarget;
      inputUpdatedCaret = true;
      batch(() => {
        c.setInputPrompt(el.value);
        c.mentions.setCaret(el.selectionStart);
      });
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
      inputUpdatedCaret = false;
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
        c.sendPrompt();
      }
    }}
  />
  <Show when={c.inputPrompt().length > 0}>
    <button
      type="button"
      onClick={() => {
        c.setInputPrompt("");
      }}
      class="ui-icon-button ui-icon-button-xs shrink-0 mr-2.5 mt-2 rounded-full text-fg-muted"
      data-rc-tip="Clear input" aria-label="Clear input"
    >
      <Iconify icon="lucide:x" size={13} />
    </button>
  </Show>
</div>
</>
  );
}
