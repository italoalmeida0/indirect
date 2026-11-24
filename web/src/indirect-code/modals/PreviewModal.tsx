import { Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Modal, Badge, Btn, StepperField, copyToClipboard, toast } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import { compactTokens } from "../context";
import { CodeBlock } from "../components/CodeBlock";
import { useModal } from "../ctx";

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PreviewModal() {
  const m = useModal();
  const file = () => m.previewFile();

  return (
    <Modal
      open={!!file()}
      onClose={() => m.setPreviewFile(null)}
      onEscape={() => {
        if (m.showTruncateInput() && !file()?.dataUrl) {
          m.setShowTruncateInput(false);
          return;
        }
        m.setPreviewFile(null);
      }}
      title={file()?.name || "File preview"}
      subtitle={
        file()?.dataUrl
          ? undefined
          : "Preview limits only affect this viewer and do not change what is sent to the agent."
      }
      width="max-w-3xl"
      badge={
        <Show when={file()?.truncated}>
          <Badge tone="warning">Truncated</Badge>
        </Show>
      }
    >
      <Show when={file()}>
        {(f) => {
          const lang = () => f().language || languageForPath(f().name);
          const isExtracting = () => f().text === "(still extracting...)";
          const isDecodeError = () => f().text === "(could not decode file)";
          const isStatusState = () => isExtracting() || isDecodeError();
          const hasText = () => Boolean(f().text) && !isStatusState();
          const isCodeLang = () => {
            const l = lang();
            return Boolean(l && l !== "plaintext" && l !== "text" && l !== "markdown");
          };
          const sizeLabel = () => formatFileSize(f().size);
          const lineCount = () => {
            const t = f().text;
            return t ? t.split(/\r?\n/).length : 0;
          };
          const estTokens = () => {
            const t = f().text;
            return t ? Math.max(1, Math.round(t.length / 4)) : 0;
          };

          return (
            <div class="rounded-panel border border-border bg-surface overflow-hidden">
              {/* File Preview Header Bar */}
              <div class="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-subtle px-3.5 py-2 flex-wrap">
                <div class="flex items-center gap-2 min-w-0 text-2xs text-fg-muted tabular-nums">
                  <Iconify
                    icon={f().dataUrl ? "lucide:image" : "lucide:file-code"}
                    size={13}
                    class="shrink-0 text-fg-secondary"
                  />
                  <span class="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-fg-secondary">
                    {f().dataUrl ? "image" : lang() || "text"}
                  </span>
                  <Show when={sizeLabel()}>
                    <span class="text-border-strong" aria-hidden="true">
                      ·
                    </span>
                    <span>{sizeLabel()}</span>
                  </Show>
                  <Show when={hasText()}>
                    <span class="text-border-strong" aria-hidden="true">
                      ·
                    </span>
                    <span>{lineCount()} lines</span>
                    <span class="text-border-strong" aria-hidden="true">
                      ·
                    </span>
                    <span>~{compactTokens(estTokens())} tok</span>
                  </Show>
                </div>

                <div class="flex items-center gap-1.5 flex-wrap ml-auto">
                  <Show when={f().truncated && f().fullText}>
                    <button
                      type="button"
                      ref={press}
                      onClick={m.restorePreviewFile}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-warning/35 bg-warning-subtle px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning/15 transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:rotate-ccw" size={12} />
                      <span>Restore full</span>
                    </button>
                  </Show>
                  <Show when={!f().dataUrl && hasText()}>
                    <button
                      type="button"
                      ref={press}
                      onClick={() => m.setShowTruncateInput(!m.showTruncateInput())}
                      class={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                        m.showTruncateInput()
                          ? "border-accent bg-accent-subtle text-fg"
                          : "border-border bg-surface text-fg-secondary hover:bg-surface-muted hover:text-fg"
                      }`}
                      data-rc-tip="Limit preview length"
                      aria-label="Limit preview length"
                    >
                      <Iconify icon="lucide:scissors" size={12} />
                      <span>Limit preview</span>
                    </button>
                  </Show>
                  <Show when={hasText()}>
                    <button
                      type="button"
                      ref={press}
                      onClick={() => {
                        void copyToClipboard(f().text || "").then((ok) => {
                          if (ok) {
                            m.setPreviewCopied(true);
                            setTimeout(() => m.setPreviewCopied(false), 1500);
                          } else {
                            toast(
                              "Could not copy automatically. Select the text and copy it manually",
                              "err",
                            );
                          }
                        });
                      }}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                    >
                      <Iconify
                        icon={m.previewCopied() ? "lucide:check" : "lucide:copy"}
                        size={12}
                        class={m.previewCopied() ? "text-success" : ""}
                      />
                      <span>
                        {m.previewCopied() ? "Copied" : isCodeLang() ? "Copy code" : "Copy"}
                      </span>
                    </button>
                  </Show>
                  <Show
                    when={
                      f().blob != null ||
                      f().dataB64 != null ||
                      f().dataUrl?.startsWith("blob:")
                    }
                  >
                    <button
                      type="button"
                      ref={press}
                      onClick={m.downloadPreviewFile}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:download" size={12} />
                      <span>Download</span>
                    </button>
                  </Show>
                </div>
              </div>

              {/* Inline Preview Slicer Drawer */}
              <Show when={m.showTruncateInput() && !f().dataUrl && hasText()}>
                <div class="border-b border-border-subtle bg-surface px-3.5 py-3 space-y-3">
                  <StepperField
                    label="Preview limit"
                    ariaLabel="Preview limit"
                    min={100}
                    max={200000}
                    step={1000}
                    unit="tokens"
                    value={String(m.truncateTokens() || 16000)}
                    onInput={(v) => m.setTruncateTokens(parseInt(v) || 16000)}
                    hint={`Approximately ${compactTokens((m.truncateTokens() || 16000) * 4)} characters rendered in the preview viewer.`}
                    presets={[
                      { label: "4K", value: "4000" },
                      { label: "16K", value: "16000" },
                      { label: "32K", value: "32000" },
                      { label: "64K", value: "64000" },
                    ]}
                  />
                  <div class="flex items-center justify-end gap-2">
                    <Btn
                      variant="outline"
                      size="xs"
                      onClick={() => m.setShowTruncateInput(false)}
                    >
                      Cancel
                    </Btn>
                    <Btn
                      size="xs"
                      onClick={() => {
                        m.truncatePreviewFile();
                        m.setShowTruncateInput(false);
                      }}
                    >
                      Apply
                    </Btn>
                  </div>
                </div>
              </Show>

              {/* Code / Media / Status Frame */}
              <div class="max-h-[56vh] overflow-auto bg-background/50 p-4 pb-5">
                <Show
                  when={f().dataUrl}
                  fallback={
                    <Show
                      when={!isStatusState()}
                      fallback={
                        <div class="flex flex-col items-center justify-center gap-2 py-10 px-4 text-center">
                          <Show
                            when={isExtracting()}
                            fallback={
                              <>
                                <Iconify icon="lucide:file-warning" size={20} class="text-fg-muted" />
                                <p class="text-xs font-medium text-fg">Could not preview this file</p>
                                <p class="text-2xs text-fg-muted">
                                  Download the file to inspect it locally.
                                </p>
                              </>
                            }
                          >
                            <span class="ui-spinner w-4 h-4 text-accent" aria-hidden="true" />
                            <p class="text-xs font-medium text-fg">Extracting file text…</p>
                            <p class="text-2xs text-fg-muted">
                              Preview will be available once extraction finishes.
                            </p>
                          </Show>
                        </div>
                      }
                    >
                      <CodeBlock
                        text={f().text || "(empty)"}
                        language={lang()}
                        bare
                        maxH="max-h-none"
                      />
                    </Show>
                  }
                >
                  <div class="flex items-center justify-center p-2">
                    <img
                      src={f().dataUrl}
                      alt={f().name || "Preview"}
                      class="max-w-full rounded-lg border border-border object-contain"
                    />
                  </div>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>
    </Modal>
  );
}
