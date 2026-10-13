/**
 * Generative UI DSL: a fenced markdown code block (```generative_ui) whose
 * body describes one interactive widget. The assistant writes it inline in
 * its markdown answer; the transcript renderer (TarnavMarkdown CodeBlock)
 * recognizes the fence and mounts the widget instead of a code block.
 *
 * Grammar (tolerant, stream-friendly — partial bodies parse as they stream):
 *
 *   placeholder: Compiling your visualization
 *   height: 320
 *   state: {"amount": 1000, "years": 5}
 *   libs: d3, gsap
 *   net: true
 *
 *   @html
 *   <div class="gu-root">...</div>
 *   @css
 *   .gu-root { ... }
 *   @js
 *   const total = document.getElementById("total");
 *   ... plain script body: sees `state`, `$render()`, `window.indirectUi` ...
 *
 * Header keys are `key: value` lines before the first @section. Sections are
 * `@html`, `@css`, `@js` (aliases: @javascript, @script). Content before any
 * @section is treated as html. Unknown keys and unknown @lines are ignored.
 */
export type GenerativeUiData = {
  placeholder?: string;
  /** Initial widget state object (from the `state:` JSON header). */
  state?: Record<string, unknown>;
  html?: string;
  css?: string;
  js?: string;
  height?: number;
  /** Libraries to preload as globals (`libs: d3, three` header). */
  libs?: string[];
  /**
   * Opt-in network capability (`net: true` header): https data/tiles and
   * esm.sh dynamic imports inside the widget. Plain http(s) images work
   * without it. Off by default.
   */
  net?: boolean;
};

const GENERATIVE_UI_LIBS = ["d3", "gsap", "chart", "three", "map"] as const;

const SECTION_RE = /^@(html|css|js|javascript|script)\s*$/i;
const HEADER_RE = /^(placeholder|height|state|libs|net)\s*:\s*(.*)$/i;

export function parseGenerativeUiDsl(raw: string | undefined): GenerativeUiData {
  const out: GenerativeUiData = {};
  if (!raw) return out;
  const sections: { html: string[]; css: string[]; js: string[] } = { html: [], css: [], js: [] };
  let current: "html" | "css" | "js" | null = null;
  let headerDone = false;

  for (const line of raw.split("\n")) {
    const section = SECTION_RE.exec(line.trim());
    if (section) {
      const name = section[1].toLowerCase();
      current = name === "css" ? "css" : name === "html" ? "html" : "js";
      headerDone = true;
      continue;
    }
    if (!headerDone && !current) {
      const header = HEADER_RE.exec(line.trim());
      if (header) {
        const key = header[1].toLowerCase();
        const value = header[2].trim();
        if (key === "placeholder") out.placeholder = value.slice(0, 120);
        else if (key === "height") {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) out.height = n;
        } else if (key === "state") {
          out.state = parseStateJSON(value);
        } else if (key === "libs") {
          const libs = parseLibs(value);
          if (libs.length) out.libs = libs;
        } else if (key === "net") {
          out.net = /^(1|true|yes|on)$/i.test(value.trim());
        }
        continue;
      }
      if (line.trim() === "") continue; // header separator
      // First non-header content line: default section is html.
      current = "html";
      headerDone = true;
    }
    (sections[current ?? "html"]).push(line);
  }

  out.html = sections.html.join("\n").trim() || undefined;
  out.css = sections.css.join("\n").trim() || undefined;
  out.js = sections.js.join("\n").trim() || undefined;
  return out;
}

/** State must be a JSON object literal; anything else is dropped. */
function parseStateJSON(value: string): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Library list: comma/space separated names, whitelisted against
 * GENERATIVE_UI_LIBS, de-duplicated, order preserved. Unknown names drop.
 */
function parseLibs(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[,\s]+/)) {
    const name = part.trim().toLowerCase();
    if ((GENERATIVE_UI_LIBS as readonly string[]).includes(name) && !out.includes(name)) out.push(name);
  }
  return out.slice(0, 4);
}

/** True when the body has enough content to mount a widget preview. */
export function hasWidgetBody(data: GenerativeUiData): boolean {
  return !!data.html || !!data.css || !!data.js;
}

export const GENERATIVE_UI_LANGS = new Set(["generative_ui", "genui"]);

export type GenerativeUiSegment =
  | { kind: "md"; text: string }
  | { kind: "widget"; body: string; closed: boolean; lang: string };

export type GenerativeUiSegmentWithId = GenerativeUiSegment & { id: string };

/**
 * Stable segment identity for store reconciliation. Streaming is append-only
 * at the tail (segments before the growing one never move), so index+kind is
 * a durable key: the markdown run before a fence keeps its id after the fence
 * completes, and a kind flip at an index (a partial fence line resolving into
 * a widget) changes the id, remounting exactly that one segment.
 */
export function generativeUiSegmentId(seg: GenerativeUiSegment, index: number): string {
  return `s${index}:${seg.kind}`;
}

export function withGenerativeUiSegmentIds(
  segs: GenerativeUiSegment[],
): GenerativeUiSegmentWithId[] {
  return segs.map((seg, i) => ({ ...seg, id: generativeUiSegmentId(seg, i) }));
}

const FENCE_OPEN_RE = /^( {0,3})(`{3,})\s*(\S*)\s*$/;

/**
 * Splits markdown into text runs and generative_ui widget runs. Fences of
 * other languages are kept inside the text runs untouched (TarnavMarkdown
 * renders them). An unterminated generative_ui fence at the end of a stream
 * becomes an open widget segment (the preview renders while it streams).
 */
export function splitGenerativeUiSegments(text: string): GenerativeUiSegment[] {
  const out: GenerativeUiSegment[] = [];
  const lines = (text || "").split("\n");
  let md: string[] = [];
  let i = 0;
  const flushMd = () => {
    if (!md.length) return;
    out.push({ kind: "md", text: md.join("\n") });
    md = [];
  };
  while (i < lines.length) {
    const open = FENCE_OPEN_RE.exec(lines[i]);
    const lang = (open?.[3] || "").toLowerCase();
    if (!open || !GENERATIVE_UI_LANGS.has(lang)) {
      md.push(lines[i]);
      i++;
      continue;
    }
    const ticks = open[2];
    const closeRe = new RegExp(`^ {0,3}${ticks}\\s*$`);
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        closed = true;
        j++;
        break;
      }
      body.push(lines[j]);
    }
    if (!closed && j === lines.length && body.length === 0 && i + 1 >= lines.length) {
      // The opening fence just arrived: show the widget placeholder now.
      closed = false;
    }
    flushMd();
    out.push({ kind: "widget", body: body.join("\n"), closed, lang });
    i = j;
  }
  flushMd();
  return out;
}
