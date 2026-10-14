/**
 * Session widget source access (generative_ui fence `id:` link).
 *
 * Snapshots carry widget METADATA only; the source is fetched on demand
 * with `get_widget` over the relay WS (same pattern as `get_attachment`),
 * answered with `widget_data`. Results are cached per host+session+id and
 * invalidated when the widget store changes (widget_set/delete), so a fence
 * re-render after an edit always gets the fresh source.
 *
 * Caching rules (each one is a regression guard):
 *   - POSITIVE-only: a `null` answer is never cached. "No widget" may mean
 *     the daemon was busy, the widget was created moments later, or the
 *     request raced a session switch — pinning that to a cache entry made
 *     widgets stay "missing" until a full page reload.
 *   - LATE answers refill the exact entry the request was made for (and
 *     bump the version so a renderer that already gave up retries). They
 *     must never land under a synthetic key nobody reads.
 *   - Answers from before an invalidation (stale epoch) never cache: a
 *     widget_set must win over an in-flight fetch of the old source.
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
  /** Cache key the answer belongs to. */
  key: string;
  /** Invalidation epoch at request time: stale answers never cache. */
  epoch: number;
};

const cache = new Map<string, WidgetSourceRecord | null>();
const pending = new Map<string, Pending>();
/**
 * Request-id -> origin of requests that already TIMED OUT. The daemon may
 * still answer them later; without this the late answer used to be cached
 * under a dead key nobody reads, while the real entry stayed empty forever
 * (the "returning to a session shows no widget" bug).
 */
const lateAnswers = new Map<string, { key: string; epoch: number }>();

/** Bumped on every invalidation; answers from an older epoch never cache. */
let epoch = 0;
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

function keyMatches(k: string, sessionId?: string, id?: string): boolean {
  const [, sid, wid] = parseKey(k);
  if (sessionId && sid !== sessionId) return false;
  if (id && wid !== id) return false;
  return true;
}

/** Caches one positive answer unless the world changed since the request. */
function cacheAnswer(k: string, reqEpoch: number, widget?: WidgetSourceRecord | null): boolean {
  if (!widget || !widget.source || reqEpoch !== epoch) return false;
  cache.set(k, widget);
  return true;
}

/**
 * Drops cached sources for one session (or one widget) after a change.
 * ALWAYS bumps the version — even when nothing was cached — so a renderer
 * sitting in the "missing" state retries after a widget_set.
 */
export function invalidateWidgetSources(sessionId?: string, id?: string): void {
  epoch++;
  for (const k of [...cache.keys()]) {
    if (keyMatches(k, sessionId, id)) cache.delete(k);
  }
  // In-flight requests and remembered late answers predate this
  // invalidation: forget them so a stale fetch can never refill the cache.
  for (const [rid, p] of [...pending]) {
    if (!keyMatches(p.key, sessionId, id)) continue;
    clearTimeout(p.timer);
    pending.delete(rid);
    p.resolve(null);
  }
  for (const [rid, o] of [...lateAnswers]) {
    if (keyMatches(o.key, sessionId, id)) lateAnswers.delete(rid);
  }
  widgetSourceVersion.set(widgetSourceVersion.get() + 1);
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
    cacheAnswer(entry.key, entry.epoch, msg.widget);
    entry.resolve(msg.widget ?? null);
    return;
  }
  // Late answer to a request that already timed out (or was dropped by an
  // invalidation): refill the entry the request was made for and bump the
  // version so the renderer that gave up retries and picks the source up.
  if (msg.requestId) {
    const origin = lateAnswers.get(msg.requestId);
    lateAnswers.delete(msg.requestId);
    if (origin && cacheAnswer(origin.key, origin.epoch, msg.widget)) {
      widgetSourceVersion.set(widgetSourceVersion.get() + 1);
    }
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
 * (or the host never answers within the timeout); null is never cached.
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
  const reqEpoch = epoch;
  return new Promise<WidgetSourceRecord | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      // The request stays registered for a very late answer — but only until
      // the next invalidation of this entry.
      if (!lateAnswers.has(requestId)) rememberLate(requestId, k, reqEpoch);
      resolve(null);
    }, timeoutMs);
    pending.set(requestId, {
      key: k,
      epoch: reqEpoch,
      resolve: (rec) => {
        cacheAnswer(k, reqEpoch, rec);
        resolve(rec);
      },
      timer,
    });
    send({ type: "get_widget", requestId, sessionId, widgetId: id });
  });
}

function rememberLate(requestId: string, k: string, reqEpoch: number): void {
  lateAnswers.set(requestId, { key: k, epoch: reqEpoch });
  // Bound the table: old unanswered request ids are worthless.
  while (lateAnswers.size > 64) lateAnswers.delete(lateAnswers.keys().next().value!);
}
