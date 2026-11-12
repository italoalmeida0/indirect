import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const IC_DIR = join(ROOT, "web", "src", "indirect-code");

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (/\.(tsx|ts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

function readIc(relPath: string): string {
  return readFileSync(join(IC_DIR, relPath), "utf8");
}

interface HtmlTitleMatch {
  file: string;
  line: number;
  tag: string;
  snippet: string;
}

/**
 * Scan JSX intrinsic lowercase HTML opening tags (`<button ...>`, `<span ...>`,
 * `<iframe ...>`, etc.) while balancing `{...}` expressions and string literals
 * so arrow functions (`onClick={() => ...}`) do not prematurely terminate tag
 * scanning. Uppercase Solid component tags (`<Modal title="...">`) are ignored.
 */
function findIntrinsicHtmlTitleAttrs(src: string, relFile: string): HtmlTitleMatch[] {
  const matches: HtmlTitleMatch[] = [];
  const tagStartRe = /<([a-z][a-z0-9-]*)\b/g;
  let m: RegExpExecArray | null;

  while ((m = tagStartRe.exec(src)) !== null) {
    const tag = m[1]!;
    const startIdx = m.index;
    const prevChar = startIdx > 0 ? src[startIdx - 1] : "";
    // Skip TypeScript generic parameters like `querySelectorAll<HTMLButtonElement>`
    // (those start uppercase anyway) or `<string>` after identifier/dot.
    if (prevChar && /[A-Za-z0-9_$.]/.test(prevChar)) continue;

    let i = startIdx + m[0].length;
    let braceDepth = 0;
    let quote: string | null = null;
    let topLevelAttrs = "";

    while (i < src.length) {
      const ch = src[i]!;
      if (quote) {
        if (ch === "\\" && i + 1 < src.length) {
          if (braceDepth === 0) topLevelAttrs += ch + src[i + 1]!;
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        if (braceDepth === 0) topLevelAttrs += ch;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        if (braceDepth === 0) topLevelAttrs += ch;
        i++;
        continue;
      }
      if (ch === "{") {
        if (braceDepth === 0) topLevelAttrs += "{expr}";
        braceDepth++;
        i++;
        continue;
      }
      if (ch === "}") {
        if (braceDepth > 0) braceDepth--;
        i++;
        continue;
      }
      if (braceDepth === 0 && ch === ">") {
        break;
      }
      if (braceDepth === 0) {
        topLevelAttrs += ch;
      }
      i++;
    }

    if (/(?:^|\s)title\s*=/.test(topLevelAttrs)) {
      const line = src.slice(0, startIdx).split("\n").length;
      const rawTag = src.slice(startIdx, Math.min(src.length, i + 1)).replace(/\s+/g, " ");
      matches.push({
        file: relFile.replace(/\\/g, "/"),
        line,
        tag,
        snippet: rawTag.slice(0, 140),
      });
    }
  }

  return matches;
}

describe("Indirect Code tooltip coverage & zero native HTML title attributes", () => {
  test("no intrinsic HTML element in web/src/indirect-code/** uses native title= except iframe[title='Interactive widget']", () => {
    const files = walkFiles(IC_DIR);
    expect(files.length).toBeGreaterThan(20);

    const allMatches: HtmlTitleMatch[] = [];
    for (const file of files) {
      const rel = relative(IC_DIR, file);
      const src = readFileSync(file, "utf8");
      allMatches.push(...findIntrinsicHtmlTitleAttrs(src, rel));
    }

    expect(allMatches).toHaveLength(1);
    expect(allMatches[0]?.file).toBe("components/generative-ui/renderer.tsx");
    expect(allMatches[0]?.tag).toBe("iframe");
    expect(allMatches[0]?.snippet).toContain('title="Interactive widget"');
  });

  test("composer toolbar, skills matrix, footer, and send/attachment controls carry data-rc-tip", () => {
    const toolbarCtx = readIc("components/composer/ToolbarContext.tsx");
    expect(toolbarCtx).toContain('data-rc-tip={ui.isMobile() ? "Add & Settings" : "Add context"}');
    expect(toolbarCtx).toContain("aria-expanded={c.addContextOpen()}");
    expect(toolbarCtx).toContain('data-rc-tip="Mode & skills"');
    expect(toolbarCtx).toContain(
      'data-rc-tip={c.yoloMode() ? "Permissions: Full access" : "Permissions: Ask for approval"}',
    );
    expect(toolbarCtx).toContain(
      "data-rc-tip={`Activation policy: ${shownUsable(name)} (click to cycle)`}",
    );
    expect(toolbarCtx).toContain('data-rc-tip="Drag to reorder"');

    const toolbarModel = readIc("components/composer/ToolbarModel.tsx");
    expect(toolbarModel).toContain('data-rc-tip="Effort & model"');

    const footer = readIc("components/composer/ComposerFooter.tsx");
    expect(footer).toContain('data-rc-tip="Context & token usage"');
    expect(footer).toContain('data-rc-tip="Project"');

    const toolbarSend = readIc("components/composer/ToolbarSend.tsx");
    expect(toolbarSend).toContain(
      'data-rc-tip={t.turnActivity()?.status === "cancelling" ? "Stopping…" : "Stop"}',
    );
    expect(toolbarSend).toContain(
      'data-rc-tip={c.sending() ? "Uploading attachments..." : isDraft() ? "Start conversation" : "Send"}',
    );

    const composerInput = readIc("components/composer/ComposerInput.tsx");
    expect(composerInput).toContain('data-rc-tip="Remove attachment"');
    expect(composerInput).toContain('data-rc-tip="Clear input"');

    const banners = readIc("components/composer/StatusBanners.tsx");
    expect(banners).toContain("data-composer-collapse");
    expect(banners).toContain("data-rc-tip={label()}");
    expect(banners).toContain('data-rc-tip="Dismiss notification"');
  });

  test("effort picker and model picker controls carry data-rc-tip", () => {
    const effort = readIc("components/EffortPickerBody.tsx");
    expect(effort).toContain("data-effort-model-btn");
    expect(effort).toContain('data-rc-tip="Switch model"');

    const model = readIc("components/ModelPickerBody.tsx");
    expect(model).toContain('data-rc-tip="Back to effort"');
    expect(model).toContain('data-rc-tip="Clear search"');
    expect(model).toContain('data-rc-tip="Refresh models"');
    expect(model).toContain('data-rc-tip="Scroll providers left"');
    expect(model).toContain('data-rc-tip="Scroll providers right"');
  });

  test("workspace header, sidebar, session rows, and host card carry data-rc-tip", () => {
    const sidebarToggle = readIc("components/SidebarToggle.tsx");
    expect(sidebarToggle).toContain("data-rc-tip={label()}");
    expect(sidebarToggle).toContain('data-rc-tip-placement="bottom"');

    const page = readIc("IndirectCodePage.tsx");
    expect(page).toContain('data-rc-tip="Conversation history (Ctrl+K)"');
    expect(page).toContain('data-rc-tip="New conversation"');
    expect(page).toContain('data-rc-tip-placement="bottom"');

    const hostCard = readIc("components/HostCard.tsx");
    const switchHostMatches = hostCard.match(/data-rc-tip="Switch host"/g) ?? [];
    expect(switchHostMatches.length).toBe(2);

    const sidebar = readIc("components/WorkspaceSidebar.tsx");
    expect(sidebar).toContain('data-rc-tip="Toggle project"');
    expect(sidebar).toContain('data-rc-tip="Copy project path"');
    expect(sidebar).toContain('data-rc-tip="Create new project"');
    expect(sidebar).toContain('data-rc-tip="Host & agent settings"');

    const sessionSidebar = readIc("components/SessionSidebar.tsx");
    expect(sessionSidebar).toContain('data-rc-tip="Rename"');
    expect(sessionSidebar).toContain('data-rc-tip="Delete"');
    expect(sessionSidebar).toContain('data-rc-tip={s.pinned ? "Unpin" : "Pin"}');
  });

  test("transcript, message actions, queue, background tasks, history, and balloons carry data-rc-tip", () => {
    const msgActions = readIc("components/MsgActions.tsx");
    expect(msgActions).toContain('data-rc-tip={props.copied ? "Copied" : props.tip}');
    expect(msgActions).toContain('tip="Fork conversation from here"');
    expect(msgActions).toContain('tip="Edit and resend"');
    expect(msgActions).toContain('tip="Regenerate response"');
    expect(msgActions).toContain("data-turn-duration");

    const transcriptView = readIc("components/TranscriptView.tsx");
    expect(transcriptView).toContain('data-rc-tip="Attach files"');
    expect(transcriptView).toContain('data-rc-tip="Remove attachment"');
    expect(transcriptView).toContain('data-rc-tip="Open preview"');

    const queue = readIc("components/QueueCard.tsx");
    expect(queue).toContain('data-rc-tip={collapsed() ? "Expand queue" : "Collapse queue"}');
    expect(queue).toContain('data-rc-tip="Sends automatically when current step finishes"');
    expect(queue).toContain('data-rc-tip="Interrupt current step and send now"');
    expect(queue).toContain('data-rc-tip="Return to queue"');
    expect(queue).toContain('data-rc-tip="Clear queued messages"');
    expect(queue).toContain('data-rc-tip="Send on next AI step"');
    expect(queue).toContain('data-rc-tip="Stop current step and send now"');
    expect(queue).toContain('data-rc-tip="Send message now"');
    expect(queue).toContain('data-rc-tip="Move earlier in queue"');
    expect(queue).toContain('data-rc-tip="Move later in queue"');
    expect(queue).toContain('tip="Edit queued message"');
    expect(queue).toContain('tip="Remove from queue"');
    expect(queue).toContain('data-rc-tip="Remove attachment"');

    const bg = readIc("components/BackgroundCard.tsx");
    expect(bg).toContain('data-rc-tip="Stop task"');
    expect(bg).toContain('data-rc-tip="Dismiss task"');
    expect(bg).toContain('data-rc-tip={isOpen(job.id) ? "Hide logs" : "Show logs"}');

    const history = readIc("components/HistoryView.tsx");
    expect(history).toContain('data-rc-tip="Back to chat"');
    expect(history).toContain('data-rc-tip="Clear search"');

    const turnChanges = readIc("components/TurnChangesBalloon.tsx");
    expect(turnChanges).toContain("data-rc-tip={meta().title}");
    expect(turnChanges).toContain("data-rc-tip={displayPath()}");
    expect(turnChanges).toContain('data-rc-tip="Refresh file changes"');

    const compaction = readIc("components/CompactionBalloon.tsx");
    expect(compaction).toContain('data-rc-tip={copied() ? "Copied" : "Copy summary"}');
    expect(compaction).toContain("data-rc-tip={file}");

    const genUi = readIc("components/generative-ui/renderer.tsx");
    expect(genUi).toContain("data-rc-tip={error()}");
    expect(genUi).toContain('data-rc-tip="Dismiss error"');
  });

  test("modals, settings, and CodeDevPage carry data-rc-tip instead of native title=", () => {
    const settingsGeneral = readIc("modals/SettingsGeneral.tsx");
    expect(settingsGeneral).toContain("data-rc-tip={item.label}");
    expect(settingsGeneral).toContain('data-rc-tip="Clear proxy"');

    const newProject = readIc("modals/NewProjectModal.tsx");
    expect(newProject).toContain('data-rc-tip="Parent folder"');
    expect(newProject).toContain('data-rc-tip="Home directory"');
    expect(newProject).toContain("data-rc-tip={crumb.path}");

    const preview = readIc("modals/PreviewModal.tsx");
    expect(preview).toContain('data-rc-tip="Limit preview length"');

    const codeDev = readIc("CodeDevPage.tsx");
    expect(codeDev).toContain("<RemoteHints />");
    expect(codeDev).toContain('data-rc-tip="Toggle compact or pretty JSON"');
    expect(codeDev).toContain('data-rc-tip="Copy full JSON"');
    expect(codeDev).toContain('data-rc-tip="Download JSON file"');
    expect(codeDev).toContain('data-rc-tip="Refresh daemon debug state"');
    expect(codeDev).toContain('data-rc-tip="Clear requests log"');
  });
});
