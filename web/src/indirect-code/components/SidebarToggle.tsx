import { Show } from "solid-js";
import { Icon } from "../../components/icon";
import { useUI } from "../ctx";

/** One control shared by the sidebar brand row and the collapsed workspace. */
export function SidebarToggle() {
  const ui = useUI();
  const label = () => ui.sidebarOpen()
    ? ui.isMobile() ? "Close sidebar" : "Collapse sidebar"
    : "Expand sidebar";
  return (
    <button
      type="button"
      onClick={() => ui.setSidebarOpen(!ui.sidebarOpen())}
      class="rc-sidebar-toggle relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
      data-rc-tip={label()}
      data-rc-tip-placement="bottom"
      aria-label={label()}
    >
      <Icon icon={ui.sidebarOpen() ? ui.isMobile() ? "lucide:x" : "lucide:panel-left-close" : "lucide:panel-left-open"} size={16} />
      <Show when={!ui.sidebarOpen() && Boolean(ui.anyOnlineHostHasUnread?.())}>
        <span
          data-sidebar-unread-badge
          aria-hidden="true"
          class="pointer-events-none absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent ring-2 ring-background"
        />
      </Show>
    </button>
  );
}
