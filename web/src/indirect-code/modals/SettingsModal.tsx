import { For, Show } from "solid-js";
import { Badge, Btn, Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";

import { SettingsGeneralSection } from "./SettingsGeneral";

export function SettingsModal() {
  const m = useModal();
  const ui = useUI();
  const hosts = useHost();
  const activeTab = m.settingsTab;
  const hostObj = () => hosts.activeHost?.() ?? null;
  const hostStatus = () => hostObj()?.status || "offline";

  const jumpTo = (id: string) => {
    m.setSettingsTab("general");
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <Modal
      open={m.showConfigModal()}
      title="Host & agent settings"
      subtitle="Customize your workspace and the agent on this host."
      width="max-w-2xl"
      onClose={m.cancelSettings}
      footer={
        <>
          <Btn
            variant="outline"
            size="sm"
            disabled={m.savingSettings()}
            onClick={m.cancelSettings}
          >
            Cancel
          </Btn>
          <Btn
            size="sm"
            disabled={m.savingSettings() || m.settingsChanged()}
            onClick={m.saveDaemonConfig}
          >
            {m.savingSettings() ? "Saving…" : "Save changes"}
          </Btn>
        </>
      }
    >
      <div class="w-full space-y-4">
        <Show when={m.settingsError() || m.settingsChanged()}>
          <div
            role="alert"
            class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-control border border-danger/35 bg-danger-subtle px-3.5 py-2.5 text-xs text-fg"
          >
            <div class="flex items-start gap-2 min-w-0">
              <Iconify icon="lucide:alert-circle" size={15} class="mt-0.5 shrink-0 text-danger" />
              <p class="leading-relaxed">
                {m.settingsError() ||
                  "Settings changed on another client. Reload the latest settings before saving."}
              </p>
            </div>
            <button
              type="button"
              class="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50"
              disabled={m.savingSettings()}
              onClick={m.reloadSettings}
            >
              Reload latest settings (discard local edits)
            </button>
          </div>
        </Show>

        <fieldset
          disabled={m.savingSettings()}
          class="min-w-0 space-y-4 disabled:opacity-60"
        >
          <Show when={ui.appNotice()}>
            {(notice) => (
              <div
                role={notice().kind === "err" ? "alert" : "status"}
                class="rounded-control border border-border bg-surface-subtle px-3.5 py-2.5 text-xs text-fg-secondary"
              >
                {notice().message}
              </div>
            )}
          </Show>

          {/* Bespoke Host Telemetry & Studio Section Strip */}
          <div class="rc-studio-well flex flex-wrap items-center justify-between gap-2.5 px-3 py-2">
            <div class="flex items-center gap-2 min-w-0">
              <span
                class={`h-2 w-2 shrink-0 rounded-full ${
                  hostStatus() === "online"
                    ? "bg-success"
                    : hostStatus() === "updating"
                      ? "bg-warning animate-pulse"
                      : "bg-fg-muted"
                }`}
              />
              <span class="truncate text-xs font-medium text-fg">
                {hostObj()?.name || hostObj()?.hostname || "Connected host"}
              </span>
              <Badge
                tone={
                  hostStatus() === "online"
                    ? "green"
                    : hostStatus() === "updating"
                      ? "amber"
                      : "zinc"
                }
              >
                {hostStatus() === "online"
                  ? "Online"
                  : hostStatus() === "updating"
                    ? "Updating"
                    : "Offline"}
              </Badge>
            </div>
            <div class="flex items-center gap-1 flex-wrap">
              <For
                each={[
                  { id: "rc-set-appearance", icon: "lucide:palette", label: "Appearance" },
                  { id: "rc-set-notifications", icon: "lucide:bell", label: "Alerts" },
                  { id: "rc-set-updates", icon: "lucide:arrow-down-to-line", label: "Updates" },
                  { id: "rc-set-runtime", icon: "lucide:sliders-horizontal", label: "Runtime" },
                ]}
              >
                {(sec) => (
                  <button
                    type="button"
                    onClick={() => jumpTo(sec.id)}
                    class="inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[11px] font-medium text-fg-secondary hover:border-border hover:bg-surface hover:text-fg transition-colors cursor-pointer"
                  >
                    <Iconify icon={sec.icon} size={12} class="text-fg-muted" />
                    <span>{sec.label}</span>
                  </button>
                )}
              </For>
            </div>
          </div>

          <Show when={activeTab() === "general" || !activeTab()}>
            <SettingsGeneralSection />
          </Show>
        </fieldset>
      </div>
    </Modal>
  );
}
