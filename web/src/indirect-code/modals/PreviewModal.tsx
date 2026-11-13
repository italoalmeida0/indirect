import { Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Modal, Badge, Btn, StepperField, copyToClipboard, toast } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { languageForPath } from "../utils/lang";
import { compactTokens } from "../context";
import { CodeBlock } from "../components/CodeBlock";
import { useModal } from "../ctx";

export function PreviewModal() {
  const m = useModal();
  const file = () => m.previewFile();

  return (
    <Modal
      open={!!file()}
      onClose={() => m.setPreviewFile(null)}
      title={file()?.name || "File preview"}
      subtitle="Inspect or download the attachment. Preview limits do not change the content sent to the agent."
      width="max-w-3xl"
      badge={
        <Show when={file()?.truncated}>
          <Badge tone="amber">Truncated</Badge>
        </Show>
      }
      footer={
        <Btn
          variant="outline"
          size="sm"
          onClick={() => m.setPreviewFile(null)}
        >
          Close
        </Btn>
      }
    >
      <Show when={file()}>
        {(f) => {
          const lang = () => f().language || languageForPath(f().name);
          const lineCount = () => {
            const t = f().text;
            return t ? t.split(/\r?\n/).length : 0;
          };
          const estTokens = () => {
            const t = f().text;
            return t ? Math.max(1, Math.round(t.length / 4)) : 0;
          };
          const footprintPct = () =>
            Math.min(100, ((m.truncateTokens() || 16000) / 128000) * 100);

          return (
            <div class="rounded-panel border border-border bg-surface overflow-hidden">
              {/* IDE File Preview Header Bar */}
              <div class="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-subtle px-3.5 py-2 flex-wrap">
                <div class="flex items-center gap-2 min-w-0 text-2xs text-fg-muted tabular-nums">
                  <Iconify
                    icon={f().dataUrl ? "lucide:image" : "lucide:file-code"}
                    size={13}
                    class="shrink-0 text-fg-secondary"
                  />
                  <span class="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-fg-secondary">
                    {f().dataUrl ? "image" : lang()}
                  </span>
                  <Show when={f().text}>
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
                      onPointerDown={(e) => press(e.currentTarget)}
                      onClick={m.restorePreviewFile}
                      class="inline-flex items-center gap-1.5 rounded-lg border border-warning/35 bg-warning-subtle px-2.5 py-1 text-xs font-medium text-warning hover:bg-warning/15 transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:rotate-ccw" size={12} />
                      <span>Restore full</span>
                    </button>
                  </Show>
                  <Show when={!f().dataUrl}>
                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
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
                  <Show when={f().text}>
                    <button
                      type="button"
                      onPointerDown={(e) => press(e.currentTarget)}
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
                      <span>{m.previewCopied() ? "Copied" : "Copy code"}</span>
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
                      onPointerDown={(e) => press(e.currentTarget)}
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
              <Show when={m.showTruncateInput() && !f().dataUrl}>
                <div class="border-b border-border-subtle bg-surface px-3.5 py-3 space-y-3">
                  <div class="space-y-1.5" aria-hidden="true">
                    <div class="flex items-center justify-between text-2xs">
                      <span class="font-medium text-fg-secondary">128K context window share</span>
                      <span class="text-fg-muted tabular-nums">
                        {footprintPct().toFixed(1)}% of 128K
                      </span>
                    </div>
                    <div class="h-1.5 rounded-full bg-surface-muted overflow-hidden">
                      <div
                        class="h-full rounded-full bg-accent transition-[width] duration-150"
                        style={{ width: `${footprintPct()}%` }}
                      />
                    </div>
                  </div>

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
                    <button
                      type="button"
                      onClick={() => m.setShowTruncateInput(false)}
                      class="px-2.5 py-1 rounded-lg text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <Btn
                      size="sm"
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

              {/* Code / Media Frame */}
              <div class="max-h-[56vh] overflow-auto bg-background/50 p-4 pb-5">
                <Show
                  when={f().dataUrl}
                  fallback={
                    <CodeBlock
                      text={f().text || "(empty)"}
                      language={lang()}
                      bare
                      maxH="max-h-none"
                    />
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
