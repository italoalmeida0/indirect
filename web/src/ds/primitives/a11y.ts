/**
 * Small accessibility helpers: roving focus for composite widgets (one Tab stop,
 * arrow keys inside).
 */

export interface RovingOptions {
  orientation?: "horizontal" | "vertical" | "both";
  loop?: boolean;
}

/**
 * Resolve the next index for an arrow/Home/End key, or undefined when the
 * key is not a navigation key. Disabled items are skipped.
 */
export function rovingIndex(
  key: string,
  current: number,
  count: number,
  isDisabled: (index: number) => boolean = () => false,
  opts: RovingOptions = {},
): number | undefined {
  if (count <= 0) return undefined;
  const orientation = opts.orientation ?? "horizontal";
  const loop = opts.loop ?? true;
  const next = orientation !== "vertical" && key === "ArrowRight" || orientation !== "horizontal" && key === "ArrowDown";
  const prev = orientation !== "vertical" && key === "ArrowLeft" || orientation !== "horizontal" && key === "ArrowUp";
  let direction: number;
  let index = current;
  if (key === "Home") { index = -1; direction = 1; }
  else if (key === "End") { index = count; direction = -1; }
  else if (next) direction = 1;
  else if (prev) direction = -1;
  else return undefined;
  for (let step = 0; step < count; step++) {
    index += direction;
    if (index < 0 || index >= count) {
      if (!loop || key === "Home" || key === "End") return current;
      index = (index + count) % count;
    }
    if (!isDisabled(index)) return index;
  }
  return current;
}
