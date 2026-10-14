/**
 * Session widget source access (generative_ui fence `id:` link).
 *
 * Snapshots carry widget METADATA only; the source is fetched on demand
 * with `get_widget` over the relay WS (same pattern as `get_attachment`),
 * answered with `widget_data`. Results are cached per host+session+id and
 * invalidated when the widget store changes (widget_set/delete), so a fence
 * re-render after an edit always gets the fresh source.
 */

export type WidgetSourceRecord = {
  id: string;
  source: string;
  placeholder?: string;
  size?: number;
  updatedAt?: number;
};

// Tiny dependency-free signal (the SPA is Solid, but this module must stay
// importable from the server-side lint tests too).
function signal<T>(initial: T) {
  let value = initial;
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
    },
  };
}

type Pending = {
  resolve: (rec: WidgetSourceRecord | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

const cache = new Map<string, WidgetSourceRecord | null>();
const pending = new Map<string, Pending>();
let reqSeq = 0;

/**
 * Bumped on every invalidation: renderers fold it into their fetch effect
 * dependencies so a dropped cache entry is actually re-fetched (an effect
 * keyed only on the widget id would never re-run).
 */
export const widgetSourceVersion = signal(0);

function key(hostId: string, sessionId: string, id: string): string {
  return JSON.stringify([hostId, sessionId, id]);
}

function parseKey(k: string): [string, string, string] {
  try {
    return JSON.parse(k);
  } catch {
    return ["", "", ""];
  }
}

/** Drops cached sources for one session (or one widget) after a change. */
export function invalidateWidgetSources(sessionId?: string, id?: string): void {
  let dropped = false;
  for (const k of [...cache.keys()]) {
    const [, sid, wid] = parseKey(k);
    if (sessionId && sid !== sessionId) continue;
    if (id && wid !== id) continue;
    cache.delete(k);
    dropped = true;
  }
  if (dropped) widgetSourceVersion.set(widgetSourceVersion.get() + 1);
}

/** Answers a `widget_data` event from the daemon. */
export function noteWidgetData(msg: {
  requestId?: string;
  sessionId?: string;
  widgetId?: string;
  widget?: WidgetSourceRecord;
}): void {
  const entry = msg.requestId ? pending.get(msg.requestId) : undefined;
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(msg.requestId!);
    entry.resolve(msg.widget ?? null);
    return;
  }
  // Unsolicited / late answer: cache it when it carries a payload.
  if (msg.widget && msg.sessionId && msg.widget.id) {
    cache.set(key("", msg.sessionId, msg.widget.id), msg.widget);
  }
}

export type GetWidgetCommand = {
  type: "get_widget";
  requestId: string;
  sessionId: string;
  widgetId: string;
};

/**
 * Fetches one widget source. Resolves null when the widget does not exist
 * (or the host never answers within the timeout).
 */
export function fetchWidgetSource(
  send: (payload: GetWidgetCommand) => void,
  hostId: string,
  sessionId: string,
  id: string,
  timeoutMs = 8000,
): Promise<WidgetSourceRecord | null> {
  const k = key(hostId, sessionId, id);
  const hit = cache.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  const requestId = `wg-${Date.now().toString(36)}-${++reqSeq}`;
  return new Promise<WidgetSourceRecord | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      // No negative caching: a widget stored later (widget_set) must be
      // visible to the next render.
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, {
      resolve: (rec) => {
        cache.set(k, rec);
        resolve(rec);
      },
      timer,
    });
    send({ type: "get_widget", requestId, sessionId, widgetId: id });
  });
}
