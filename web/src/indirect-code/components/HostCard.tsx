import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";
import { FloatMenu } from "./FloatMenu";
import { UnreadDot } from "./LiveIndicators";

/** Host selector card + floating menu, shared by the sidebar bottom and
 * the full-screen update overlay (UpdateFreezeOverlay).
 *
 * One card instance = one anchor: each HostCard owns its trigger ref
 * LOCALLY (never a shared `hosts.hostBtn` variable). The old shared ref
 * was assigned by whichever card rendered last — sidebar vs overlay
 * fought over it, and the open menu anchored to the hidden card so it
 * appeared "lá em cima" after update/switch. Here the menu renders only
 * when THIS card is the opener (hostMenuAnchor match), so a stale open
 * flag or a hidden card can never misposition it.
 *
 * `id` must be unique per mount site ("sidebar" | "overlay"). */
export function HostCard(props: { id: "sidebar" | "overlay" }) {
  const h = useHost();
  const m = useModal();
  const ui = useUI();
  let btn: HTMLButtonElement | undefined;
  const mine = () => h.hostMenuOpen() && h.hostMenuAnchor() === props.id;
  const statusDot = () => {
    if (h.connectionState() !== "connected") return "bg-warning animate-pulse";
    const st = h.activeHost()?.status;
    if (st === "online") return "bg-success";
    if (st === "updating") return "bg-warning animate-pulse";
    return "bg-fg-muted";
  };
  const statusLabel = () =>
    h.connectionState() !== "connected"
      ? "Reconnecting…"
      : h.activeHost()?.status === "online"
        ? "Connected"
        : h.activeHost()?.status === "updating"
          ? "Updating…"
          : "Offline";

  const hostName = () => h.activeHost()?.name || h.activeHost()?.hostname || "Select host";

  return (
    <>
      <Show
        when={props.id === "sidebar"}
        fallback={
          <button
            type="button"
            ref={btn}
            data-menubtn
            data-rc-tip="Switch host"
            aria-label={`Select host: ${hostName()} ${statusLabel()}`}
            aria-haspopup="menu"
            aria-expanded={h.hostMenuOpen()}
            onClick={() => {
              const next = h.hostMenuAnchor() === props.id ? !h.hostMenuOpen() : true;
              ui.closeMenus();
              h.setHostMenuAnchor(props.id);
              h.setHostMenuOpen(next);
            }}
            class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-muted transition-colors cursor-pointer"
          >
            <span aria-hidden="true" class="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-subtle text-fg-muted shrink-0">
              <Iconify icon="lucide:monitor" size={14} />
            </span>
            <span aria-hidden="true" class="flex-1 min-w-0">
              <span class="block truncate text-xs font-medium text-fg">{hostName()}</span>
              <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
                <span class={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot()}`} />
                <span class="truncate">{statusLabel()}</span>
              </span>
            </span>
            <span aria-hidden="true" class="inline-flex shrink-0 items-center gap-1.5">
              <Show when={Boolean(h.anyOtherHostHasUnread?.())}>
                <span data-other-host-unread class="inline-flex items-center">
                  <UnreadDot size="sm" />
                </span>
              </Show>
              <Iconify icon="lucide:chevrons-up-down" size={13} class="text-fg-muted shrink-0" />
            </span>
          </button>
        }
      >
        <button
          type="button"
          ref={btn}
          data-menubtn
          data-rc-tip="Switch host"
          aria-label={`Select host: ${hostName()} ${statusLabel()}`}
          aria-haspopup="menu"
          aria-expanded={h.hostMenuOpen()}
          onClick={() => {
            const next = h.hostMenuAnchor() === props.id ? !h.hostMenuOpen() : true;
            ui.closeMenus();
            h.setHostMenuAnchor(props.id);
            h.setHostMenuOpen(next);
          }}
          class={`rc-nav-row text-left cursor-pointer ${
            mine()
              ? "bg-surface-muted text-fg"
              : "text-fg-secondary hover:bg-surface-muted/75 hover:text-fg"
          }`}
        >
          <span aria-hidden="true" class="rc-nav-icon text-fg-muted">
            <Iconify icon="lucide:monitor" size={14} />
          </span>
          <span aria-hidden="true" class="min-w-0 flex-1 truncate font-medium text-fg">
            {hostName()}
          </span>
          <span aria-hidden="true" class="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
            <span class={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot()}`} />
            <Show when={Boolean(h.anyOtherHostHasUnread?.())}>
              <span data-other-host-unread class="inline-flex items-center">
                <UnreadDot size="sm" />
              </span>
            </Show>
            <Iconify icon="lucide:chevrons-up-down" size={12} class="text-fg-muted/80" />
          </span>
        </button>
      </Show>
      <FloatMenu anchor={() => (btn?.isConnected ? btn : undefined)} open={mine()} placement="top-start" width="17.5rem">
        <div class="px-2 py-1 text-[11px] font-medium text-fg-muted flex items-center justify-between select-none">
          <span>Your hosts</span>
          <span class="font-mono text-[10px] tabular-nums">{h.hosts().length}</span>
        </div>
        <div role="menu" aria-label="Hosts" class="space-y-0.5">
          <For each={h.hosts()}>{(host) => {
            const active = () => host.id === h.activeHostId();
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active()}
                class={`w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors cursor-pointer ${
                  active()
                    ? "bg-surface-muted text-fg"
                    : "hover:bg-surface-muted/70 focus-visible:bg-surface-muted/70 text-fg-secondary hover:text-fg"
                }`}
                onClick={() => { h.setHostMenuOpen(false); h.setActiveHostId(host.id); }}
              >
                <span class="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/80 bg-surface-subtle text-fg-muted">
                  <Iconify icon="lucide:monitor" size={13} class={active() ? "text-fg" : ""} />
                  <span
                    class={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-surface-raised ${
                      host.status === "online" ? "bg-success" : host.status === "updating" ? "bg-warning" : "bg-fg-muted"
                    }`}
                  />
                </span>
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-xs font-medium text-fg">{host.name || host.hostname || host.id}</span>
                  <span class="block text-[11px] text-fg-muted">
                    {host.status === "online" ? "Online" : host.status === "updating" ? "Updating…" : "Offline"}
                    {host.os ? ` · ${host.os}` : ""}
                  </span>
                </span>
                <Show when={Boolean(h.hostHasUnread?.(host.id))}>
                  <span data-host-unread={host.id} class="inline-flex items-center shrink-0">
                    <UnreadDot size="sm" label="Unread updates on this host" />
                  </span>
                </Show>
                <Show when={active()}>
                  <Iconify icon="lucide:check" size={13} class="text-fg shrink-0" />
                </Show>
              </button>
            );
          }}</For>
        </div>
        <div class="mt-1 border-t border-border/70 pt-1 space-y-0.5">
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-muted/70 transition-colors cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void h.loadHosts(); }}
          >
            <Iconify icon="lucide:refresh-cw" size={13} class="text-fg-muted" />
            <span>Refresh hosts</span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-muted/70 transition-colors cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void m.generatePairingToken(); }}
          >
            <Iconify icon="lucide:plus" size={13} class="text-fg-muted" />
            <span>Connect another host</span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-danger hover:bg-danger-subtle transition-colors cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void h.removeHost(); }}
          >
            <Iconify icon="lucide:trash-2" size={13} />
            <span>Remove current host</span>
          </button>
        </div>
      </FloatMenu>
    </>
  );
}
