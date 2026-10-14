/**
 * Transcript-wide "one live instance per widget" registry.
 *
 * Several fences in a transcript can link the same `widget_id:` (a widget
 * re-emitted as it evolved). Mounting every instance keeps one live iframe
 * per fence — heavy when the widget pulls vendored libs (three, d3). The
 * LAST instance in document order claims the id and stays live; earlier
 * ones are superseded (they render an unloaded card until manually loaded).
 * When the active instance unmounts (message deleted, session switch), the
 * newest remaining one is reactivated automatically.
 *
 * Pure module (no Solid): claim order is registration order, which Solid
 * effects follow in document order.
 */

export type LiveWidgetEntry = {
  token: symbol;
  onSupersede: () => void;
  onReactivate: () => void;
};

const stacks = new Map<string, LiveWidgetEntry[]>();

/** Registers an instance for a widget id; the newest claim wins. */
export function claimLiveWidget(id: string, entry: LiveWidgetEntry): void {
  const stack = stacks.get(id) ?? [];
  // Only the previous ACTIVE (top) instance is superseded — the rest are
  // already superseded and must not get duplicate events.
  const prev = stack[stack.length - 1];
  if (prev) prev.onSupersede();
  stack.push(entry);
  stacks.set(id, stack);
}

/** Unregisters an instance; the newest survivor becomes active again. */
export function releaseLiveWidget(id: string, token: symbol): void {
  const stack = stacks.get(id);
  if (!stack) return;
  const i = stack.findIndex((e) => e.token === token);
  if (i < 0) return;
  stack.splice(i, 1);
  if (!stack.length) {
    stacks.delete(id);
    return;
  }
  // Only the top of the stack is live; releasing a superseded instance
  // changes nothing at the top.
  if (i === stack.length) stack[stack.length - 1].onReactivate();
}

/** Test hook: how many instances are registered for a widget id. */
export function liveWidgetCount(id: string): number {
  return stacks.get(id)?.length ?? 0;
}
