/**
 * Generative UI block DSL (pure, no DOM).
 *
 * The widget is a markdown DSL (```generative_ui fenced block). The body is
 * a React component: optional header lines, then one `@jsx` marker and the
 * JSX/TSX source file. `@tsx` is accepted as an alias of `@jsx`.
 *
 * Header keys are `key: value` lines before the @jsx marker. Unknown keys
 * are ignored. Everything after the marker is verbatim source — later lines
 * are never re-parsed as headers or markers.
 */
export type GenerativeUiData = {
  placeholder?: string;
  /** Initial widget state object (from the `state:` JSON header). */
  state?: Record<string, unknown>;
  /** Libraries to preload (only names in LIBS are honored). */
  libs?: string[];
  /** The React widget source (whole body after the `@jsx` marker). */
  jsx?: string;
};

/** Only these libs exist as vetted local bundles. */
const LIBS = new Set(["d3", "gsap", "chart", "three", "map"]);

const JSX_SECTION_RE = /^@(jsx|tsx)\s*$/i;
const HEADER_RE = /^(placeholder|state|libs)\s*:\s*(.*)$/i;

export function parseGenerativeUiDsl(raw: string | undefined): GenerativeUiData {
  const out: GenerativeUiData = {};
  if (!raw) return out;
  const jsxLines: string[] = [];
  let inJsx = false;
  let headerDone = false;

  for (const line of raw.split("\n")) {
    // React source is verbatim: later lines are never re-parsed.
    if (inJsx) {
      jsxLines.push(line);
      continue;
    }
    const jsxSection = JSX_SECTION_RE.exec(line.trim());
    if (jsxSection) {
      inJsx = true;
      headerDone = true;
      continue;
    }
    if (!headerDone) {
      const header = HEADER_RE.exec(line.trim());
      if (header) {
        const key = header[1].toLowerCase();
        const value = header[2].trim();
        if (key === "placeholder") out.placeholder = value.slice(0, 120);
        else if (key === "state") {
          out.state = parseStateJSON(value);
        } else if (key === "libs") {
          const libs = parseLibs(value);
          if (libs.length) out.libs = libs;
        }
        continue;
      }
      if (line.trim() === "") continue; // header separator
      headerDone = true;
    }
  }

  if (jsxLines.length) {
    out.jsx = jsxLines.join("\n").trim() || undefined;
  }
  return out;
}

function parseStateJSON(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `libs: d3, three` / `libs: three d3` — tolerate comma and whitespace
 * separators. Unknown names are dropped (not honored by the doc builder).
 */
function parseLibs(value: string): string[] {
  const parts = value
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => LIBS.has(s));
  return [...new Set(parts)];
}

/** True when the body has a widget source to mount. */
export function hasWidgetBody(data: GenerativeUiData): boolean {
  return !!data.jsx;
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
