/**
 * Generative UI block DSL (pure, no DOM).
 *
 * The widget is a markdown DSL (```generative_ui fenced block). The fence
 * has HEADER LINES ONLY — no body:
 *
 *   - `widget_id:` (required to mount) — links to the widget source stored
 *     in the session's widget store with the widget_set tool.
 *   - `placeholder:` — short label shown while the widget loads.
 *   - `state:` — JSON default state, passed as props to the widget App.
 *
 * Header keys are `key: value` lines. Unknown keys are ignored. A fence
 * without a `widget_id:` renders as a static card (placeholder + state
 * preview) — session migration has already rewritten the legacy fence
 * shapes.
 */
export type GenerativeUiData = {
  placeholder?: string;
  /** Default widget state object (from the `state:` JSON header). */
  state?: Record<string, unknown>;
  /** Widget id linking to the session's widget store (the `widget_id:` header). */
  id?: string;
};

const HEADER_RE = /^(placeholder|state|widget_id)\s*:\s*(.*)$/i;

export function parseGenerativeUiDsl(raw: string | undefined): GenerativeUiData {
  const out: GenerativeUiData = {};
  if (!raw) return out;

  for (const line of raw.split("\n")) {
    const header = HEADER_RE.exec(line.trim());
    if (header) {
      const key = header[1].toLowerCase();
      const value = header[2].trim();
      if (key === "placeholder") out.placeholder = value.slice(0, 120);
      else if (key === "state") out.state = parseStateJSON(value);
      else if (key === "widget_id") out.id = value.slice(0, 120) || undefined;
      continue;
    }
    if (line.trim() === "") continue; // header separator
    // Any non-header content is legacy noise (migration rewrites it away);
    // ignore it — the fence links by id only.
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

export const GENERATIVE_UI_LANGS = new Set(["generative_ui", "genui"]);

export type GenerativeUiSegment =
  | { kind: "md"; text: string }
  | { kind: "widget"; body: string; closed: boolean; lang: string };

export type GenerativeUiSegmentWithId = GenerativeUiSegment & { id: string };

/**
 * Segment ids of EARLIER duplicates: several fences in one transcript can
 * link the same `widget_id:` (a widget edited and re-emitted over time).
 * Mounting every instance keeps one live iframe per fence — heavy when the
 * widget pulls vendored libs (three, d3). Only the LAST fence of a given
 * widget id mounts live; earlier ones are frozen (static card) and can be
 * mounted manually.
 */
export function frozenDuplicateSegmentIds(segs: GenerativeUiSegmentWithId[]): Set<string> {
  const lastById = new Map<string, string>();
  for (const seg of segs) {
    if (seg.kind !== "widget") continue;
    const id = parseGenerativeUiDsl(seg.body).id;
    if (id) lastById.set(id, seg.id);
  }
  const frozen = new Set<string>();
  for (const seg of segs) {
    if (seg.kind !== "widget") continue;
    const id = parseGenerativeUiDsl(seg.body).id;
    if (id && lastById.get(id) !== seg.id) frozen.add(seg.id);
  }
  return frozen;
}

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
 * becomes an open widget segment (the placeholder renders while it streams).
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
