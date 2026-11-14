import { onCleanup } from "solid-js";

let scopeRefCount = 0;

/**
 * Marks `document.documentElement` with `data-indirect-code=""` while at least
 * one Indirect Code shell (`WorkspaceShell` or `CodeDevPage`) is mounted, so
 * shell CSS covers all workspace scroll containers and `<Portal>` overlays
 * mounted under `document.body` without affecting Gateway screens.
 */
export function useIndirectCodeDocumentScope(): void {
  if (typeof document === "undefined") return;
  let active = true;
  scopeRefCount += 1;
  document.documentElement.setAttribute("data-indirect-code", "");
  onCleanup(() => {
    if (!active) return;
    active = false;
    scopeRefCount = Math.max(0, scopeRefCount - 1);
    if (scopeRefCount === 0) {
      document.documentElement.removeAttribute("data-indirect-code");
    }
  });
}
