/**
 * Partial-HTML closer for generative_ui streaming (ported from
 * OpenIntelligentUI process-partial-html.ts). The model streams the html
 * argument token by token; the preview renders the longest complete prefix:
 * cut at the last finished construct, close still-open tags in order.
 */

const TAG_RE = /<\s*(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

/**
 * Returns the longest complete prefix of an HTML fragment and closes any
 * tags left open in that prefix. Invalid or partial markup at the cut point
 * is trimmed rather than parsed leniently, so intermediate renders always
 * show valid markup.
 */
export function processPartialHtml(html: string): string {
  if (!html) return "";
  // Cut a trailing incomplete tag (a '<' that never closes); keep all text.
  let cut = html.length;
  const lastLt = html.lastIndexOf("<");
  if (lastLt !== -1 && html.indexOf(">", lastLt) === -1) cut = lastLt;
  const body = html.slice(0, cut);
  const openStack: string[] = [];
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(body)) !== null) {
    const [full, closing, nameRaw] = match;
    const name = nameRaw.toLowerCase();
    if (closing) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue;
      openStack.splice(idx, 1);
    } else if (!full.endsWith("/>") && !VOID_ELEMENTS.has(name)) {
      openStack.push(name);
    }
  }
  return body + openStack.reverse().map((n) => `</${n}>`).join("");
}
