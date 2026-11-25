import { batch, createEffect, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { useComposerCtx, useModal, useSession, useUI } from "../../ctx";
import { MentionMenu } from "../MentionMenu";
import { FileIcon } from "../../presentation";
import { useVoice } from "../../voice/VoiceContext";
import { VoiceRevealOverlay, VoiceStatusOverlay } from "../../voice/VoiceOverlays";

const SIMPLE_SINGLE_LINE_ASCII_RE = /^[a-z0-9 .,;:!?'-]+$/;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes || 0))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

export function syncComposerHeight(el: HTMLTextAreaElement, text: string) {
  if (!text) {
    el.style.height = "";
    el.style.overflowY = "hidden";
    return;
  }
  const h = el.style.height;
  // Only bypass scrollHeight measurement when the text is guaranteed to fit on
  // one line (lowercase/digit ASCII with generous per-glyph headroom); CJK,
  // emoji, uppercase, and near-width lines always measure accurately.
  if (
    !text.includes("\n") &&
    (h === "" || h === "36px") &&
    el.scrollWidth <= el.clientWidth &&
    el.clientWidth > 32 &&
    SIMPLE_SINGLE_LINE_ASCII_RE.test(text) &&
    text.length * 12 <= el.clientWidth - 32
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
  const voice = useVoice();
  let textareaRef: HTMLTextAreaElement | undefined;
  let inputUpdatedCaret = false;
  const [dragActive, setDragActive] = createSignal(false);
  const hideTextarea = () => voice.isActive() || Boolean(voice.reveal()?.active);
  const hasDraftDuringVoice = () => voice.isActive() && Boolean(c.inputPrompt().trim());

  createEffect(() => {
    const text = c.inputPrompt();
    if (!textareaRef) return;
    if (textareaRef.value !== text) {
      textareaRef.value = text;
    }
    syncComposerHeight(textareaRef, text);
  });

  createEffect(() => {
    if (voice.isActive() && textareaRef && typeof document !== "undefined" && document.activeElement === textareaRef) {
      textareaRef.blur();
    }
  });

  return (
<div
  class="relative flex flex-col"
  onDragEnter={(e) => {
    if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
  }}
  onDragOver={(e) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes("Files")) setDragActive(true);
  }}
  onDragLeave={(e) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragActive(false);
  }}
  onDrop={(e) => {
    e.preventDefault();
    setDragActive(false);
    try {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length > 0) c.handleFiles(files);
    } catch {}
  }}
>
<MentionMenu mentions={c.mentions} inputId="rc-composer" />
<Show when={dragActive()}>
  <div class="pointer-events-none absolute inset-1.5 z-20 flex items-center justify-center gap-2 rounded-inner border border-dashed border-accent bg-surface/95 backdrop-blur-xs px-3 py-2 text-xs font-medium text-accent">
    <Iconify icon="lucide:upload-cloud" size={14} />
    <span>Drop files to attach to prompt</span>
  </div>
</Show>
<Show when={c.preparingAttachments() > 0}>
  <p role="status" class="px-3.5 pt-3 flex items-center gap-1.5 text-xs text-fg-muted">
    <span class="ui-spinner text-accent shrink-0" aria-hidden="true" />
    <span>
      Preparing {c.preparingAttachments()} {c.preparingAttachments() === 1 ? "file" : "files"}…
    </span>
  </p>
</Show>
{/* Attachment chips */}
<Show when={c.pendingAttachments().length > 0}>
  <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
    <For each={c.pendingAttachments()}>
      {(att) => (
        <div
          data-widget-attachment={att.widgetSlot ? att.widgetSlot : att.widgetOwner ? "static" : undefined}
          class={`group inline-flex items-center rounded-inner border max-w-[240px] text-xs transition-colors ${
            att.widgetSlot
              ? "bg-accent-subtle/60 border-accent/35 hover:border-accent/60 hover:bg-accent-subtle"
              : "bg-surface-subtle border-border hover:border-border-strong hover:bg-surface-muted"
          }`}
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
            data-rc-tip={
              att.widgetSlot
                ? `Live from widget · ${att.name} (${formatFileSize(att.size)}) · click to preview`
                : `${att.name} (${formatFileSize(att.size)}) · click to preview`
            }
            class="flex min-w-0 items-center gap-1.5 pl-2 pr-1 py-1 text-left cursor-pointer"
          >
            <Show
              when={att.loading}
              fallback={<FileIcon path={att.name} size={15} />}
            >
              <span class="ui-spinner text-accent shrink-0" aria-hidden="true" />
            </Show>
            <span class="truncate text-fg font-medium">{att.name}</span>
            <Show when={att.widgetSlot}>
              <Iconify icon="lucide:link-2" size={11} class="shrink-0 text-accent" aria-hidden="true" />
            </Show>
            <span class="shrink-0 font-mono text-2xs text-fg-muted tabular-nums">
              {formatFileSize(att.size)}
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
            class="shrink-0 mr-1 flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:text-danger hover:bg-danger-subtle transition-colors cursor-pointer"
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
<div class={`relative flex items-start${hasDraftDuringVoice() ? " min-h-[54px]" : ""}`}>
  <textarea
    id="rc-composer"
    ref={textareaRef}
    disabled={s.creatingSession() || c.sending()}
    readOnly={voice.isActive()}
    tabIndex={voice.isActive() ? -1 : undefined}
    rows={1}
    class={`flex-1 min-w-0 bg-transparent text-[13px] leading-[20px] text-fg placeholder:text-fg-muted focus:outline-none resize-none px-3.5 pt-3 pb-1 max-h-[160px] min-h-9 overflow-y-hidden${hideTextarea() ? " opacity-0 pointer-events-none" : ""}${voice.isActive() ? " !max-h-9" : ""}`}
    placeholder={ui.isMobile() ? "Ask anything · @ files · / actions" : "Ask anything, @ to mention, / for actions"}
    value={c.inputPrompt()}
    onFocus={() => c.mentions.setFocused(true)}
    onBlur={() => { c.mentions.setFocused(false); }}
    onSelect={(e) => {
      c.mentions.setCaret(e.currentTarget.selectionStart);
      voice.captureSelection(e.currentTarget);
    }}
    onClick={(e) => {
      c.mentions.setCaret(e.currentTarget.selectionStart);
      voice.captureSelection(e.currentTarget);
    }}
    onKeyUp={(e) => {
      voice.captureSelection(e.currentTarget);
      if (inputUpdatedCaret) {
        inputUpdatedCaret = false;
        return;
      }
      c.mentions.setCaret(e.currentTarget.selectionStart);
    }}
    onInput={(e) => {
      const el = e.currentTarget;
      inputUpdatedCaret = true;
      if (voice.reveal()?.active) voice.clearReveal();
      voice.captureSelection(el);
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
    onKeyDown={(e) => {
      inputUpdatedCaret = false;
      if (voice.isActive()) {
        if (e.key !== "Escape") e.preventDefault();
        return;
      }
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
  <Show when={c.inputPrompt().length > 0 && !hideTextarea()}>
    <button
      type="button"
      onClick={() => {
        c.setInputPrompt("");
      }}
      class="inline-flex h-6 w-6 shrink-0 mr-2.5 mt-2 items-center justify-center rounded-full text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
      data-rc-tip="Clear input" aria-label="Clear input"
    >
      <Iconify icon="lucide:x" size={13} />
    </button>
  </Show>
  <VoiceStatusOverlay
    active={voice.isActive()}
    listening={voice.state() === "listening"}
    statusText={voice.statusText()}
    statusMeta={voice.statusMeta()}
    draftText={c.inputPrompt()}
  />
  <VoiceRevealOverlay
    reveal={voice.reveal()}
    onDismiss={() => {
      voice.clearReveal();
      textareaRef?.focus();
    }}
  />
</div>
</div>
  );
}
