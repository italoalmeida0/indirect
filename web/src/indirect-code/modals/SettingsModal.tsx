import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Badge } from "../../ds/components/controls";
import { press } from "../../ds/motion/press";
import { reducedMotion } from "../../ds/motion/reduced";
import { Btn, Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal } from "../ctx";
import { validateProxyUrl } from "../hooks/useSettings";

import { SettingsGeneralSection } from "./SettingsGeneral";

const SETTINGS_SECTIONS = [
  { id: "rc-set-appearance", label: "Appearance" },
  { id: "rc-set-notifications", label: "Notifications" },
  { id: "rc-set-updates", label: "Updates" },
  { id: "rc-set-permissions", label: "Permissions" },
  { id: "rc-set-runtime", label: "Runtime" },
] as const;

export function SettingsModal() {
  const m = useModal();
  const hosts = useHost();
  const hostObj = () => hosts.activeHost?.() ?? null;
  const hostStatus = () => hostObj()?.status || "offline";
  const [bodyEl, setBodyEl] = createSignal<HTMLDivElement | undefined>(undefined);
  const [activeSection, setActiveSection] = createSignal<string>(SETTINGS_SECTIONS[0].id);

  const proxyInvalid = () => Boolean(validateProxyUrl(m.daemonSettings().httpProxy ?? ""));

  const jumpTo = (id: string) => {
    setActiveSection(id);
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({
        behavior: reducedMotion() ? "auto" : "smooth",
        block: "start",
      });
    });
  };

  createEffect(() => {
    const container = bodyEl();
    if (!m.showConfigModal() || !container) return;

    const updateActive = () => {
      const containerRect = container.getBoundingClientRect();
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <= 12;
      if (atBottom) {
        setActiveSection(SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1].id);
        return;
      }
      let current: string = SETTINGS_SECTIONS[0].id;
      for (const sec of SETTINGS_SECTIONS) {
        const el = document.getElementById(sec.id);
        if (!el) continue;
        const offset = el.getBoundingClientRect().top - containerRect.top;
        if (offset <= 88) {
          current = sec.id;
        }
      }
      setActiveSection(current);
    };

    updateActive();
    container.addEventListener("scroll", updateActive, { passive: true });
    onCleanup(() => container.removeEventListener("scroll", updateActive));
  });

  const requestClose = () => {
    if (m.savingSettings()) return;
    if (m.settingsDirty() && typeof m.showConfirm === "function") {
      void m
        .showConfirm({
          title: "Discard unsaved changes?",
          message:
            "Your host setting changes have not been saved yet. Discard them and close Settings?",
          confirmText: "Discard",
          cancelText: "Keep editing",
          danger: true,
        })
        .then((ok) => {
          if (ok) m.cancelSettings();
        });
      return;
    }
    m.cancelSettings();
  };

  return (
    <Modal
      open={m.showConfigModal()}
      title="Host & agent settings"
      subtitle="Customize this device and the agent running on your host."
      width="max-w-2xl"
      bodyRef={setBodyEl}
      onClose={requestClose}
      footer={
        <div class="flex w-full items-center justify-between gap-3 flex-wrap">
          <Show when={m.settingsDirty()}>
            <span class="text-2xs text-fg-muted">Unsaved host changes</span>
          </Show>
          <div class="flex items-center gap-2 ml-auto">
            <Btn
              variant="outline"
              size="sm"
              disabled={m.savingSettings()}
              onClick={requestClose}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              disabled={
                m.savingSettings() ||
                m.settingsChanged() ||
                !m.configLoaded() ||
                !m.settingsDirty() ||
                proxyInvalid()
              }
              onClick={m.saveDaemonConfig}
            >
              {m.savingSettings() ? "Saving…" : "Save changes"}
            </Btn>
          </div>
        </div>
      }
    >
      <div class="w-full min-w-0">
        {/* Sticky Host Telemetry & Section Jump Bar (flush with dialog header & scroll padding) */}
        <div class="sticky -top-4 sm:-top-5 z-10 -mx-4 sm:-mx-6 -mt-4 sm:-mt-5 mb-4 px-4 sm:px-6 py-2 sm:py-2.5 bg-surface-raised border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-x-3 gap-y-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <span class="truncate text-xs font-medium text-fg">
              {hostObj()?.name || hostObj()?.hostname || "Connected host"}
            </span>
            <Badge
              dot
              tone={
                hostStatus() === "online"
                  ? "success"
                  : hostStatus() === "updating"
                    ? "warning"
                    : "neutral"
              }
            >
              {hostStatus() === "online"
                ? "Online"
                : hostStatus() === "updating"
                  ? "Updating"
                  : "Offline"}
            </Badge>
          </div>
          <nav
            aria-label="Settings sections"
            class="flex w-full sm:w-auto items-center justify-between sm:justify-start gap-0.5 overflow-x-auto no-scrollbar max-w-full"
          >
            <For each={SETTINGS_SECTIONS}>
              {(sec) => {
                const isActive = () => activeSection() === sec.id;
                return (
                  <button
                    type="button"
                    data-settings-jump={sec.id}
                    aria-current={isActive() ? "true" : undefined}
                    disabled={m.savingSettings()}
                    ref={press}
                    onClick={() => jumpTo(sec.id)}
                    class={`inline-flex shrink-0 whitespace-nowrap items-center rounded-lg px-1.5 sm:px-2 py-1 text-[10.5px] sm:text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-50 ${
                      isActive()
                        ? "bg-surface-muted text-fg"
                        : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
                    }`}
                  >
                    <span>{sec.label}</span>
                  </button>
                );
              }}
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
              class="inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-fg hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50"
              disabled={m.savingSettings()}
              onClick={m.reloadSettings}
              aria-label="Reload latest settings (discard local edits)"
            >
              Reload latest settings
            </button>
          </div>
        </Show>

        <fieldset
          disabled={m.savingSettings()}
          class="min-w-0 disabled:opacity-60"
        >
          <SettingsGeneralSection />
        </fieldset>
      </div>
    </Modal>
  );
}
