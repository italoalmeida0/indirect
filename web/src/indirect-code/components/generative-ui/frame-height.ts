/**
 * Widget frame height bookkeeping (pure — the renderer owns the cache).
 *
 * The frame starts thin and grows to the height the widget reports over the
 * bridge. Two end-of-turn paths used to collapse the card to its start height
 * until the session was reopened:
 *
 * 1. The backend re-sends the turn tail at end of turn and the snapshot
 *    reconciliation re-triggers publishing with content that compiles to the
 *    same module — the published URL is unchanged, the iframe keeps its
 *    document, never reloads and never re-reports a height. Zeroing the
 *    height unconditionally stranded the card at the start height.
 * 2. The transcript row remounts (segment identity shifts when the re-sent
 *    tail normalizes the fence text) and its height signal starts at 0.
 *
 * The renderer caches the last measured height per content-addressed URL and
 * routes every publish outcome through this resolver: an unchanged URL keeps
 * its measurement (restoring the cached one on remount), a new URL starts at
 * 0 only when its height is not already known.
 */
export function resolvePublishedFrame(args: {
  /** URL the publish returned (content-addressed: same content = same URL). */
  nextUrl: string;
  /** URL currently rendered ("" on a fresh mount). */
  currentUrl: string;
  /** Height currently applied (0 = not measured on this mount). */
  currentHeight: number;
  /** Last measured height for `nextUrl`, if any. */
  cachedHeight?: number;
}): { url: string; height: number } {
  if (args.nextUrl === args.currentUrl) {
    // Same document: the iframe never reloads, so no new measurement will
    // arrive. Keep the height it already reported.
    return {
      url: args.currentUrl,
      height: args.currentHeight > 0 ? args.currentHeight : args.cachedHeight ?? 0,
    };
  }
  // New (or first) document: grow from the widget's own measurement unless
  // this exact content was measured before.
  return { url: args.nextUrl, height: args.cachedHeight ?? 0 };
}
