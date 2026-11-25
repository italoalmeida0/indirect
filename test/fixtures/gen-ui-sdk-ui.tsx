import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { StreamingMarkdown } from "../../web/src/indirect-code/components/StreamingMarkdown";
import { ComposerInput } from "../../web/src/indirect-code/components/composer/ComposerInput";
import { PreviewModal } from "../../web/src/indirect-code/modals/PreviewModal";
import { createAttachmentDraft } from "../../web/src/indirect-code/hooks/useAttachmentDraft";
import { createModals } from "../../web/src/indirect-code/hooks/useModals";
import { noteWidgetData } from "../../web/src/indirect-code/components/generative-ui/widget-source";
import {
  ComposerCtx,
  HostCtx,
  ModalCtx,
  SessionCtx,
  UICtx,
  type GatewayModel,
} from "../../web/src/indirect-code/ctx";
import { VoiceProvider } from "../../web/src/indirect-code/voice/VoiceContext";
import { createVoiceController } from "../../web/src/indirect-code/voice/useVoice";
import type { PendingAttachment } from "../../web/src/indirect-code/viewTypes";

declare global {
  interface Window {
    __sdkFixture?: {
      setModel: (id: string) => void;
      setEffort: (e: string) => void;
      getAttachments: () => PendingAttachment[];
      getToasts: () => string[];
    };
  }
}

function FixtureApp() {
  const hostId = (window as any).__FIXTURE_HOST_ID__ || "host_fixture";
  const sessionId = "sess_sdk_ui";
  const models: GatewayModel[] = (window as any).__FIXTURE_MODELS__ || [];
  const widgetSource: string = (window as any).__FIXTURE_WIDGET_SOURCE__ || "";

  const [activeModel, setActiveModel] = createSignal(models[0]?.id || "");
  const [effort, setEffort] = createSignal("medium");
  const [inputPrompt, setInputPrompt] = createSignal("");
  const [previewFile, setPreviewFile] = createSignal<any>(null);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);
  const [truncateLimit, setTruncateLimit] = createSignal(5000);
  const [composerCollapsed, setComposerCollapsed] = createSignal(false);
  const toasts: string[] = [];

  const modals = createModals({
    toast: (msg) => {
      toasts.push(msg);
    },
  });

  const draft = createAttachmentDraft({
    send: () => {},
    isOpen: () => true,
    toast: (msg) => {
      toasts.push(msg);
    },
  });

  const voice = createVoiceController({
    getHostId: () => hostId,
    getSessionId: () => sessionId,
    getInputPrompt: () => inputPrompt(),
    setInputPrompt: (v) => setInputPrompt(v),
    onToast: (msg) => toasts.push(msg),
  });

  const hostVal: any = {
    activeHostId: () => hostId,
    send: (payload: any) => {
      if (payload?.type === "get_widget" && payload.widgetId === "sdk_demo") {
        queueMicrotask(() =>
          noteWidgetData({
            requestId: payload.requestId,
            sessionId: payload.sessionId,
            widgetId: payload.widgetId,
            widget: { id: "sdk_demo", source: widgetSource },
          }),
        );
      }
    },
  };

  const sessionVal: any = {
    activeSessionId: () => sessionId,
    creatingSession: () => false,
    draftMode: () => false,
  };

  const composerVal: any = {
    ...draft,
    inputPrompt,
    setInputPrompt,
    sending: () => false,
    activeModel,
    activeModelName: () => models.find((m) => m.id === activeModel())?.name || activeModel(),
    models: () => models,
    effort,
    sendPrompt: () => {},
    sendWidgetPrompt: async () => {},
    slashMatches: () => [],
    slashIndex: () => 0,
    setSlashIndex: () => {},
    pickSlash: () => {},
    dismissSlash: () => {},
    mentions: {
      open: () => false,
      index: () => 0,
      setIndex: () => {},
      matches: () => [],
      loading: () => false,
      setFocused: () => {},
      setCaret: () => {},
      keyDown: () => false,
      active: () => false,
      items: () => [],
      selectedIndex: () => 0,
      select: () => {},
      pick: () => {},
      dismiss: () => {},
    },
  };

  const modalVal: any = {
    ...modals,
    previewFile,
    setPreviewFile,
    previewCopied: () => false,
    copyPreview: () => {},
    showTruncateInput,
    setShowTruncateInput,
    truncateLimit,
    setTruncateLimit,
    applyPreviewTruncate: () => {},
    restorePreviewFile: () => {},
    previewPending: (att: PendingAttachment) => {
      setPreviewFile({
        name: att.name,
        size: att.size,
        text: att.text,
        dataUrl: att.objectUrl,
      });
    },
  };

  const uiVal: any = {
    isMobile: () => window.innerWidth < 640,
    composerCollapsed,
    setComposerCollapsed,
    toast: (msg: string) => toasts.push(msg),
  };

  window.__sdkFixture = {
    setModel: setActiveModel,
    setEffort,
    getAttachments: () => draft.pendingAttachments(),
    getToasts: () => [...toasts],
  };

  const markdown = [
    "```generative_ui",
    "widget_id: sdk_demo",
    "placeholder: Embedded AI and attachment demo",
    'state: {"player":"Ada"}',
    "```",
  ].join("\n");

  return (
    <HostCtx.Provider value={hostVal}>
      <SessionCtx.Provider value={sessionVal}>
        <ComposerCtx.Provider value={composerVal}>
          <ModalCtx.Provider value={modalVal}>
            <UICtx.Provider value={uiVal}>
              <VoiceProvider value={voice}>
                <div class="min-h-screen bg-background text-fg p-3 sm:p-6 max-w-3xl mx-auto space-y-4">
                  <StreamingMarkdown>{markdown}</StreamingMarkdown>
                  <div class="rounded-panel border border-border bg-surface">
                    <ComposerInput />
                  </div>
                  <PreviewModal />
                </div>
              </VoiceProvider>
            </UICtx.Provider>
          </ModalCtx.Provider>
        </ComposerCtx.Provider>
      </SessionCtx.Provider>
    </HostCtx.Provider>
  );
}

render(() => <FixtureApp />, document.getElementById("root")!);
