import { For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Badge, Btn, Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal } from "../ctx";

import { SettingsGeneralSection } from "./SettingsGeneral";

export function SettingsModal() {
  const m = useModal();
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
            disabled={m.savingSettings() || m.settingsChanged() || !m.settingsDirty()}
            onClick={m.saveDaemonConfig}
          >
            {m.savingSettings() ? "Saving…" : "Save changes"}
          </Btn>
        </>
      }
    >
      <div class="w-full min-w-0">
        {/* Sticky Host Telemetry & Section Jump Bar (flush with dialog header & scroll padding) */}
        <div class="sticky -top-4 sm:-top-5 z-10 -mx-4 sm:-mx-6 -mt-4 sm:-mt-5 mb-4 px-4 sm:px-6 py-2.5 bg-surface-raised border-b border-border-subtle flex flex-wrap items-center justify-between gap-2">
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
          <nav aria-label="Settings sections" class="flex items-center gap-0.5 flex-wrap">
            <For
              each={[
                { id: "rc-set-appearance", label: "Appearance" },
                { id: "rc-set-notifications", label: "Alerts" },
                { id: "rc-set-updates", label: "Updates" },
                { id: "rc-set-mid-turn-send", label: "Queue" },
                { id: "rc-set-runtime", label: "Runtime" },
              ]}
            >
              {(sec) => (
                <button
                  type="button"
                  disabled={m.savingSettings()}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => jumpTo(sec.id)}
                  class="inline-flex min-h-7 [@media(pointer:coarse)]:min-h-11 items-center rounded-lg px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer disabled:opacity-50"
                >
                  {sec.label}
                </button>
              )}
            </For>
          </nav>
        </div>

        <Show when={m.settingsError() || m.settingsChanged()}>
          <div
            role="alert"
            class="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-panel border border-danger/35 bg-danger-subtle px-3.5 py-2.5 text-xs text-fg"
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
              class="ui-button ui-button-outline ui-button-xs shrink-0 rounded-lg"
              disabled={m.savingSettings()}
              onClick={m.reloadSettings}
            >
              Reload latest settings
            </button>
          </div>
        </Show>

        <fieldset
          disabled={m.savingSettings()}
          class="min-w-0 disabled:opacity-60"
        >
          <Show when={activeTab() === "general" || !activeTab()}>
            <SettingsGeneralSection />
          </Show>
        </fieldset>
      </div>
    </Modal>
  );
}
