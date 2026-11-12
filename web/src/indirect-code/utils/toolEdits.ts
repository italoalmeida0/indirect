/** Parser for the edit/patch result rendering (extracted from
 * ToolEditBodies — framework-free so bun:test can cover it directly). */

export interface FileEditSection {
  file: string;
  status: "applied" | "dry_run" | "error";
  matches?: number;
  error?: string;
  diff: string;
}

export function parseEditResults(raw: string, defaultPath?: string): FileEditSection[] {
  let text = (raw || "").trim();
  if (!text) return [];

  text = text
    .replace(
      /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
      "",
    )
    .trim();

  const lines = text.split("\n");
  const sections: FileEditSection[] = [];
  let current: FileEditSection | null = null;
  const diffLines: string[] = [];

  const flush = () => {
    if (current) {
      current.diff = diffLines.join("\n").trim();
      sections.push(current);
      diffLines.length = 0;
      current = null;
    }
  };

  // A Windows drive letter (`C:\…`) also contains a colon — it must not
  // be mistaken for the `path: message` error separator (which is always
  // `colon + space`; the drive colon is followed by `\` or `/`).
  const headerRegex = /^([✓○✗])\s+(.+?)(?:\s+\((\d+)\s+match(?:es)?\)|:\s+(.*))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === "APPLIED." ||
      trimmed.startsWith("DRY RUN —") ||
      trimmed.startsWith("---") ||
      trimmed.startsWith("+++")
    ) {
      continue;
    }
    const m = line.match(headerRegex);
    if (m) {
      flush();
      const mark = m[1];
      const file = m[2].trim();
      const matchesStr = m[3];
      const errStr = m[4];
      const status: "applied" | "dry_run" | "error" =
        mark === "✗" ? "error" : mark === "○" ? "dry_run" : "applied";
      current = {
        file,
        status,
        matches: matchesStr ? parseInt(matchesStr, 10) : undefined,
        error: errStr?.trim() || undefined,
        diff: "",
      };
    } else if (current) {
      diffLines.push(line);
    } else if (trimmed) {
      diffLines.push(line);
    }
  }
  flush();

  if (sections.length === 0 && diffLines.length > 0) {
    const rawDiff = diffLines.join("\n").trim();
    if (rawDiff) {
      const isErr = /^(?:edit \d+:|error:|failed)/i.test(rawDiff);
      sections.push({
        file: defaultPath || "",
        status: isErr ? "error" : "applied",
        error: isErr ? rawDiff : undefined,
        diff: isErr ? "" : rawDiff,
      });
    }
  }

  return sections;
}

function buildEditHunk(idx: number, oldText: string, newText: string): string {
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const hunkLines: string[] = [`@@ edit ${idx + 1} @@`];
  const ctxStart = Math.max(0, prefix - 2);
  for (let i = ctxStart; i < prefix; i++) hunkLines.push(` ${oldLines[i]}`);
  for (let i = prefix; i < oldLines.length - suffix; i++) hunkLines.push(`-${oldLines[i]}`);
  for (let i = prefix; i < newLines.length - suffix; i++) hunkLines.push(`+${newLines[i]}`);
  const ctxEnd = Math.min(oldLines.length, oldLines.length - suffix + 2);
  for (let i = oldLines.length - suffix; i < ctxEnd; i++) hunkLines.push(` ${oldLines[i]}`);
  return hunkLines.join("\n");
}

function normalizeRawEditList(args: any): any[] {
  if (!args || typeof args !== "object") return [];
  const rawEdits = args.edits;
  if (Array.isArray(rawEdits)) return rawEdits;
  if (typeof rawEdits === "string") {
    const trimmed = rawEdits.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return [parsed];
      } catch {
        return [];
      }
    }
    return [];
  }
  if (rawEdits && typeof rawEdits === "object") return [rawEdits];

  const topOld = args.old_text ?? args.old_string ?? args.old;
  const topNew = args.new_text ?? args.new_string ?? args.new;
  if (typeof topOld === "string" || typeof topNew === "string") {
    return [{ old_text: topOld ?? "", new_text: topNew ?? "" }];
  }
  return [];
}

/**
 * Synthesizes `FileEditSection[]` directly from `edit` / `patch` / `widget_edit`
 * tool call arguments when transient `toolDetails.display` is absent (e.g.
 * post-reload WAL hydration where `<tool_result>` carries an empty body, or
 * in-flight edit previews).
 */
export function synthesizeEditSectionsFromArgs(
  args: any,
  defaultPath = "",
  status: "applied" | "dry_run" | "error" = "applied",
): FileEditSection[] {
  const list = normalizeRawEditList(args);
  const byFile = new Map<string, { hunks: string[]; count: number }>();

  for (let idx = 0; idx < list.length; idx++) {
    const item = list[idx];
    if (!item || typeof item !== "object") continue;
    const rawOld = item.old_text ?? item.old_string ?? item.old;
    const rawNew = item.new_text ?? item.new_string ?? item.new;
    const oldText = typeof rawOld === "string" ? rawOld : "";
    const newText = typeof rawNew === "string" ? rawNew : "";
    if (!oldText && !newText) continue;
    const targetFile = String(item.path || item.file || defaultPath || "");
    const hunk = buildEditHunk(idx, oldText, newText);
    const existing = byFile.get(targetFile);
    if (existing) {
      existing.hunks.push(hunk);
      existing.count += 1;
    } else {
      byFile.set(targetFile, { hunks: [hunk], count: 1 });
    }
  }

  if (byFile.size > 0) {
    const out: FileEditSection[] = [];
    for (const [file, group] of byFile.entries()) {
      out.push({
        file,
        status,
        matches: group.count,
        diff: group.hunks.join("\n"),
      });
    }
    return out;
  }

  const rawPatch = typeof (args?.patch ?? args?.diff) === "string" ? String(args.patch ?? args.diff).trim() : "";
  if (rawPatch) {
    return parseEditResults(rawPatch, defaultPath).map((sec) =>
      sec.status === "error" ? sec : { ...sec, status },
    );
  }

  return [];
}
