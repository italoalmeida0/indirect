import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Batch 3 Bug Fixes & Regression Suite", () => {
  const root = join(import.meta.dir, "..");

  test("BUG-T2-02 & BUG-T5-R3-04: Markdown Table styles and Copy/Download controls in TarnavMarkdown", () => {
    const src = readFileSync(join(root, "web/src/indirect-code/components/TarnavMarkdown.tsx"), "utf-8");
    // Table semantic tokens
    expect(src).toContain('table: "w-full border-collapse border border-(--line)"');
    expect(src).toContain('"table-header": "bg-(--ink-900)"');
    expect(src).not.toContain("border-border");
    expect(src).not.toContain("bg-muted/80");

    // Copy table and download CSV controls
    expect(src).toContain("DOWNLOAD_SVG");
    expect(src).toContain("function tableToCSV");
    expect(src).toContain("function tableToMarkdown");
    expect(src).toContain("function makeDownloadButton");
    expect(src).toContain('makeCopyButton(() => tableToMarkdown(table), "Copy table"');
    expect(src).toContain('makeDownloadButton(() => table, "Download CSV"');
  });

  test("BUG-R3-T1-02: FloatMenu WAI-ARIA keyboard navigation, role='menu' and Escape close", () => {
    const src = readFileSync(join(root, "web/src/indirect-code/components/FloatMenu.tsx"), "utf-8");
    expect(src).toContain('role="menu"');
    expect(src).toContain('tabIndex={-1}');
    expect(src).toContain('e.key === "Escape"');
    expect(src).toContain('props.onClose?.()');
    expect(src).toContain('props.anchor()?.focus()');
    expect(src).toContain('e.key === "ArrowDown"');
    expect(src).toContain('e.key === "ArrowUp"');
  });

  test("BUG-R3-T3-02: Tooltip disabled prop prevents overlap when usage popover is open", () => {
    const uiSrc = readFileSync(join(root, "web/src/ui.tsx"), "utf-8");
    expect(uiSrc).toContain("disabled?: boolean;");
    expect(uiSrc).toContain("if (props.disabled) return;");

    const footerSrc = readFileSync(join(root, "web/src/indirect-code/components/composer/ComposerFooter.tsx"), "utf-8");
    expect(footerSrc).toContain('disabled={ui.usageOpen()}');
  });

  test("BUG-R3-T3-03 & BUG-R3-T3-05: Compaction progress and notice warning level", () => {
    const workerSrc = readFileSync(join(root, "indirect-code-daemon/cmd/daemon/turn_worker.go"), "utf-8");
    expect(workerSrc).toContain('payload["event"] = map[string]any{"type": "compact_progress", "text": e.Text}');

    const attachSrc = readFileSync(join(root, "indirect-code-daemon/cmd/daemon/turn_attachments.go"), "utf-8");
    expect(attachSrc).toContain('"level": "warn"');

    const pageSrc = readFileSync(join(root, "web/src/indirect-code/IndirectCodePage.tsx"), "utf-8");
    expect(pageSrc).toContain('case "notice":');
    expect(pageSrc).toContain('msg.level === "warn"');
  });

  test("BUG-R3-T3-06: CompactionBalloon strips raw markdown syntax from collapsed preview", () => {
    const balloonSrc = readFileSync(join(root, "web/src/indirect-code/components/CompactionBalloon.tsx"), "utf-8");
    expect(balloonSrc).toContain("const previewSnippet = () =>");
    expect(balloonSrc).toContain(".replace(/^#+\\s+/gm, \"\")");
    expect(balloonSrc).toContain(".replace(/[*_~`]/g, \"\")");
    expect(balloonSrc).toContain("{previewSnippet()}");
  });

  test("BUG-R3-T4-05: Attachment chips keyboard accessibility in ComposerInput", () => {
    const inputSrc = readFileSync(join(root, "web/src/indirect-code/components/composer/ComposerInput.tsx"), "utf-8");
    expect(inputSrc).toContain('role="button"');
    expect(inputSrc).toContain("tabIndex={0}");
    expect(inputSrc).toContain('aria-label={`Preview ${att.name}`}');
    expect(inputSrc).toContain('e.key === "Enter" || e.key === " "');
  });

  test("BUG-R3-T4-06 & BUG-T2-03: Thinking row button semantics, aria-expanded, and single-click expansion", () => {
    const blockSrc = readFileSync(join(root, "web/src/indirect-code/components/TranscriptBlocks.tsx"), "utf-8");
    expect(blockSrc).toContain('<button');
    expect(blockSrc).toContain('type="button"');
    expect(blockSrc).toContain('aria-expanded={open()}');
    expect(blockSrc).toContain('aria-label={label()}');
    expect(blockSrc).toContain("onlyThinking = createMemo(");
    expect(blockSrc).toContain("(open() && onlyThinking())");
  });

  test("BUG-R3-T4-09: Session timestamp contrast WCAG AA in SessionSidebar", () => {
    const sidebarSrc = readFileSync(join(root, "web/src/indirect-code/components/SessionSidebar.tsx"), "utf-8");
    expect(sidebarSrc).toContain('text-[10px] text-ink-500 transition-opacity');
    expect(sidebarSrc).not.toContain('text-[10px] text-ink-600 transition-opacity');
  });

  test("BUG-T5-R3-03: Connection banner network offline indicator", () => {
    const bannerSrc = readFileSync(join(root, "web/src/indirect-code/components/composer/StatusBanners.tsx"), "utf-8");
    expect(bannerSrc).toContain("!navigator.onLine ? \"Network offline\"");
    expect(bannerSrc).toContain("Check your internet connection to continue.");
  });

  test("BUG-T5-R3-05: useRelay window online/offline listeners", () => {
    const relaySrc = readFileSync(join(root, "web/src/indirect-code/hooks/useRelay.ts"), "utf-8");
    expect(relaySrc).toContain('window.addEventListener("online", onOnline)');
    expect(relaySrc).toContain('window.addEventListener("offline", onOffline)');
    expect(relaySrc).toContain('window.removeEventListener("online", onOnline)');
    expect(relaySrc).toContain('window.removeEventListener("offline", onOffline)');
  });

  test("BUG-T5-R3-06: Python tool output bounded truncation and UI badge", () => {
    const pySrc = readFileSync(join(root, "indirect-code-daemon/packages/agent/tools/python.go"), "utf-8");
    expect(pySrc).toContain("truncation := truncateTail(text, defaultMaxLines, defaultMaxBytes)");
    expect(pySrc).toContain('attrs = append(attrs, core.Attr{Key: "truncated", Value: "true"})');

    const editSrc = readFileSync(join(root, "web/src/indirect-code/components/tool/ToolEditBodies.tsx"), "utf-8");
    expect(editSrc).toContain("props.u.result?.toolDetails?.truncated");
    expect(editSrc).toContain("Output truncated (showing last");
  });

  test("BUG-T3-12: Project row copy path action button in WorkspaceSidebar", () => {
    const wsSrc = readFileSync(join(root, "web/src/indirect-code/components/WorkspaceSidebar.tsx"), "utf-8");
    expect(wsSrc).toContain('aria-label={`Copy path for ${p.name}`}');
    expect(wsSrc).toContain('data-rc-tip="Copy project path"');
    expect(wsSrc).toContain("void copyWithToast(p.path)");
  });

  test("BUG-T5-05 & BUG-R3-T4-07: High Contrast theme and settings label for/id bindings", () => {
    const settingsSrc = readFileSync(join(root, "web/src/indirect-code/modals/SettingsGeneral.tsx"), "utf-8");
    expect(settingsSrc).toContain('{ value: "high-contrast", label: "Contrast" }');
    expect(settingsSrc).toContain('for="settings-auto-update"');
    expect(settingsSrc).toContain('id="settings-auto-update"');
    expect(settingsSrc).toContain('for="settings-upstream-proxy"');
    expect(settingsSrc).toContain('id="settings-upstream-proxy"');
    expect(settingsSrc).toContain('for="settings-auto-title"');
    expect(settingsSrc).toContain('id="settings-auto-title"');

    const uiSrc = readFileSync(join(root, "web/src/ui.tsx"), "utf-8");
    expect(uiSrc).toContain('"high-contrast"');

    const cssSrc = readFileSync(join(root, "web/style.tailwindcss.css"), "utf-8");
    expect(cssSrc).toContain('html[data-theme="high-contrast"]');
  });
});
