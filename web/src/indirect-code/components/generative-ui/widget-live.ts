/**
 * Session-level "one live instance per session" registry.
 *
 * Several widgets in a session can mount simultaneously (e.g. counter-widget,
 * greeter-widget, or duplicate fences of the same widget). Mounting every instance
 * keeps multiple live iframes — heavy when widgets pull vendored libs (three, d3).
 * To keep resource usage bounded, only ONE widget iframe remains live per session.
 * The newest claim in the session wins and stays live; earlier widgets are
 * superseded (they render an unloaded placeholder card until manually loaded).
 * When the active instance unmounts (message deleted, session switch), the
 * newest remaining one is reactivated automatically.
 *
 * Pure module (no Solid): claim order is registration order, which Solid
 * effects follow in document order.
 */

export type LiveWidgetEntry = {
  token: symbol;
  id?: string;
  onSupersede: () => void;
  onReactivate: () => void;
};

const sessionStacks = new Map<string, LiveWidgetEntry[]>();
const tokenToSession = new Map<symbol, string>();
const tokenToWidgetId = new Map<symbol, string>();

/** Registers an instance for a widget / session; the newest claim in the session wins. */
export function claimLiveWidget(id: string, entry: LiveWidgetEntry, sessionId?: string): void {
  const scopeKey = sessionId || id;
  const stack = sessionStacks.get(scopeKey) ?? [];

  // Remove existing entry with same token if present (e.g. re-claiming)
  const existingIdx = stack.findIndex((e) => e.token === entry.token);
  if (existingIdx >= 0) {
    stack.splice(existingIdx, 1);
  }

  // Only the previous ACTIVE (top) instance is superseded — the rest are
  // already superseded and must not get duplicate events.
  const prev = stack[stack.length - 1];
  if (prev && prev.token !== entry.token) prev.onSupersede();

  entry.id = id;
  stack.push(entry);
  sessionStacks.set(scopeKey, stack);
  tokenToSession.set(entry.token, scopeKey);
  tokenToWidgetId.set(entry.token, id);
}

/** Unregisters an instance; the newest survivor in the session becomes active again. */
export function releaseLiveWidget(id: string, token: symbol, sessionId?: string): void {
  const scopeKey = sessionId || tokenToSession.get(token) || id;
  const stack = sessionStacks.get(scopeKey);
  if (!stack) return;
  const i = stack.findIndex((e) => e.token === token);
  if (i < 0) return;
  stack.splice(i, 1);
  tokenToSession.delete(token);
  tokenToWidgetId.delete(token);
  if (!stack.length) {
    sessionStacks.delete(scopeKey);
    return;
  }
  // Only the top of the stack is live; releasing a superseded instance
  // changes nothing at the top.
  if (i === stack.length) stack[stack.length - 1].onReactivate();
}

/** Test hook: how many instances are registered for a widget id (or session). */
export function liveWidgetCount(id: string, sessionId?: string): number {
  if (sessionId) {
    const stack = sessionStacks.get(sessionId);
    if (!stack) return 0;
    return stack.filter((e) => !id || e.id === id || tokenToWidgetId.get(e.token) === id).length;
  }
  if (sessionStacks.has(id)) {
    return sessionStacks.get(id)?.length ?? 0;
  }
  let count = 0;
  for (const stack of sessionStacks.values()) {
    for (const e of stack) {
      if (e.id === id || tokenToWidgetId.get(e.token) === id) count++;
    }
  }
  return count;
}
