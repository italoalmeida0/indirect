import { createSignal } from "solid-js";

interface FullscreenWidgetEntry {
  id: symbol;
  close: () => void;
}

const [entries, setEntries] = createSignal<FullscreenWidgetEntry[]>([]);

export function registerFullscreenWidget(close: () => void): () => void {
  const id = Symbol("gu-fullscreen");
  setEntries((prev) => [...prev, { id, close }]);
  return () => {
    setEntries((prev) => prev.filter((item) => item.id !== id));
  };
}

export function hasFullscreenWidget(): boolean {
  return entries().length > 0;
}

export function closeTopFullscreenWidget(): boolean {
  const list = entries();
  const top = list[list.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
