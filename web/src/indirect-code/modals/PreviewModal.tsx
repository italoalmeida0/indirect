import { Show } from "solid-js";
import { Modal, Badge, Btn, StepperField, copyWithToast } from "../../ui";
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
      title={file()?.name || "File Preview"}
      subtitle="Inspect or download the attachment. Preview limits do not change the content sent to the agent."
      width="max-w-3xl"
      badge={
        <Show when={file()?.truncated}>
          <Badge tone="amber">truncated</Badge>
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
          return (
            <div class="space-y-3.5">
              {/* Bespoke File Telemetry & Action Toolbar */}
              <div class="rc-studio-well flex items-center justify-between gap-2.5 px-3 py-2 flex-wrap">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <Show when={f().truncated && f().fullText}>
                    <button
                      type="button"
                      onClick={m.restorePreviewFile}
                      class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-control border bg-warning-subtle border-warning/35 text-warning hover:bg-warning/20 transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:rotate-ccw" size={12} />
                      <span>Restore Full</span>
                    </button>
                  </Show>
                  <Show when={!f().dataUrl}>
                    <button
                      type="button"
                      onClick={() => m.setShowTruncateInput(!m.showTruncateInput())}
                      class={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-control border transition-colors cursor-pointer ${
                        m.showTruncateInput()
                          ? "border-accent bg-accent-subtle text-accent"
                          : "border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted"
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
                      onClick={() => {
                        copyWithToast(f().text || "");
                        m.setPreviewCopied(true);
                        setTimeout(() => m.setPreviewCopied(false), 1500);
                      }}
                      class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-control border border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                    >
                      <Iconify
                        icon={m.previewCopied() ? "lucide:check" : "lucide:copy"}
                        size={12}
                        class={m.previewCopied() ? "text-success" : ""}
                      />
                      <span>{m.previewCopied() ? "Copied!" : "Copy Code"}</span>
                    </button>
                  </Show>
                  <Show when={f().dataB64 != null}>
                    <button
                      type="button"
                      onClick={m.downloadPreviewFile}
                      class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-control border border-border bg-surface text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
                    >
                      <Iconify icon="lucide:download" size={12} />
                      <span>Download</span>
                    </button>
                  </Show>
                </div>

                <div class="flex items-center gap-2 text-[11px] font-mono text-fg-muted ml-auto">
                  <Show when={f().text}>
                    <span>{lineCount()} lines</span>
                    <span class="text-border-strong">·</span>
                    <span>~{compactTokens(estTokens())} tok</span>
                    <span class="text-border-strong">·</span>
                  </Show>
                  <span class="rounded-md border border-border bg-surface px-2 py-0.5 text-fg-secondary">
                    {f().dataUrl ? "image" : lang()}
                  </span>
                </div>
              </div>

              {/* Truncate input card */}
              <Show when={m.showTruncateInput() && !f().dataUrl}>
                <div class="rc-studio-card p-3.5 space-y-3">
                  {/* Context Window Footprint Slicer Bar */}
                  <div class="rc-studio-well p-2.5 space-y-1.5" aria-hidden="true">
                    <div class="flex items-center justify-between text-[11px]">
                      <span class="text-fg-secondary font-medium">128K Context Window Footprint</span>
                      <span class="font-mono text-accent">
                        {Math.min(100, ((m.truncateTokens() || 16000) / 128000) * 100).toFixed(1)}% of 128K window
                      </span>
                    </div>
                    <div class="h-1.5 rounded-full bg-surface-muted overflow-hidden">
                      <div
                        class="h-full bg-accent rounded-full transition-all"
                        style={{ width: `${Math.min(100, ((m.truncateTokens() || 16000) / 128000) * 100)}%` }}
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
                      class="text-xs text-fg-secondary hover:text-fg px-2.5 py-1 cursor-pointer"
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

              {/* Code / Image Content Viewer */}
              <div class="max-h-[55vh] overflow-auto rounded-panel border border-border bg-surface-subtle p-4 shadow-resting">
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
                  <div class="flex items-center justify-center p-4">
                    <img src={f().dataUrl} alt={f().name || "Preview"} class="max-w-full rounded-xl object-contain shadow-raised" />
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
