import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";
import { FloatMenu } from "./FloatMenu";

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

  return (
    <>
      <button
        type="button"
        ref={btn}
        data-menubtn
        aria-label={`Select host: ${h.activeHost()?.name || h.activeHost()?.hostname || "Select host"} ${statusLabel()}`}
        aria-haspopup="menu"
        aria-expanded={h.hostMenuOpen()}
        onClick={() => {
          // Same instance re-clicked while open -> close. A stale open
          // from the OTHER card -> steal it (switch anchor here).
          const next = h.hostMenuAnchor() === props.id ? !h.hostMenuOpen() : true;
          ui.closeMenus();
          h.setHostMenuAnchor(props.id);
          h.setHostMenuOpen(next);
        }}
        class="w-full flex items-center gap-2.5 rounded-panel border border-border bg-surface px-2.5 py-2 text-left hover:bg-surface-muted hover:border-border-strong shadow-resting transition-all cursor-pointer"
      >
        <span aria-hidden="true" class="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-subtle text-accent shrink-0">
          <Iconify icon="lucide:monitor" size={15} />
        </span>
        <span aria-hidden="true" class="flex-1 min-w-0">
          <span class="block truncate text-xs font-medium text-fg">
            {h.activeHost()?.name || h.activeHost()?.hostname || "Select host"}
          </span>
          <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <span class={`h-1.5 w-1.5 rounded-full shrink-0 ${statusDot()}`} />
            <span class="truncate">{statusLabel()}</span>
          </span>
        </span>
        <Iconify icon="lucide:chevrons-up-down" size={13} class="text-fg-muted shrink-0" />
      </button>
      <FloatMenu anchor={() => (btn?.isConnected ? btn : undefined)} open={mine()} placement="top-start" width="18rem">
        <div class="px-2.5 py-1.5 text-[11px] font-medium text-fg-muted flex items-center justify-between">
          <span>Your hosts</span>
          <span class="font-mono text-[10px]">{h.hosts().length}</span>
        </div>
        <div role="menu" aria-label="Hosts" class="space-y-0.5">
          <For each={h.hosts()}>{(host) => {
            const active = () => host.id === h.activeHostId();
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={active()}
                class={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors cursor-pointer ${
                  active()
                    ? "bg-accent-subtle text-fg"
                    : "hover:bg-surface-muted focus-visible:bg-surface-muted text-fg-secondary hover:text-fg"
                }`}
                onClick={() => { h.setHostMenuOpen(false); h.setActiveHostId(host.id); }}
              >
                <span class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-fg-muted">
                  <Iconify icon="lucide:monitor" size={14} class={active() ? "text-accent" : ""} />
                  <span
                    class={`absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full ring-2 ring-surface ${
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
                <Show when={active()}>
                  <Iconify icon="lucide:check" size={14} class="text-accent shrink-0" />
                </Show>
              </button>
            );
          }}</For>
        </div>
        <div class="mt-1.5 border-t border-border pt-1.5 space-y-0.5">
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void h.loadHosts(); }}
          >
            <Iconify icon="lucide:refresh-cw" size={13} class="text-fg-muted" />
            <span>Refresh hosts</span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-fg hover:bg-surface-muted transition-colors cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void m.generatePairingToken(); }}
          >
            <Iconify icon="lucide:plus" size={13} class="text-accent" />
            <span>Connect another host</span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-danger hover:bg-danger-subtle transition-colors cursor-pointer"
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
