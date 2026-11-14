import { createSignal, Show } from "solid-js";
import { Portal, render } from "solid-js/web";
import { WorkspaceShell } from "../../web/src/indirect-code/IndirectCodePage";
import { useIndirectCodeDocumentScope } from "../../web/src/indirect-code/utils/documentScope";
import { WIDGET_BASE_CSS } from "../../web/src/indirect-code/components/generative-ui/widget-doc";

function ExtraScopeProbe() {
  useIndirectCodeDocumentScope();
  return <div id="extra-scope-probe" class="hidden" />;
}

function ScrollbarsFixture() {
  const [mode, setMode] = createSignal<"code" | "gateway">("code");
  const [extraScope, setExtraScope] = createSignal(false);
  const [portalOpen, setPortalOpen] = createSignal(true);

  (window as any).scrollbarsUI = {
    mode,
    setMode,
    extraScope,
    setExtraScope,
    portalOpen,
    setPortalOpen,
  };

  const widgetSrcDoc = `<!doctype html>
<html>
<head><style>${WIDGET_BASE_CSS}</style></head>
<body>
  <div class="gu-root">
    <div id="gu-scroller" class="gu-card" style="width: 220px; height: 110px; overflow-y: auto; padding: 10px;">
      <div style="height: 360px;">Widget card</div>
    </div>
  </div>
</body>
</html>`;

  const workspaceBody = () => (
    <div class="flex flex-wrap items-start gap-4 p-4">
      {/* 1. Scroller directly over --background */}
      <div
        id="bg-scroller"
        class="h-40 w-52 overflow-y-auto border border-border bg-background p-3 text-xs text-fg"
      >
        <div style={{ height: "460px" }}>Background scroller</div>
      </div>

      {/* 2. Scroller over --surface card */}
      <div
        id="surface-scroller"
        class="h-40 w-52 overflow-y-auto rounded-none border border-border bg-surface p-3 text-xs text-fg"
      >
        <div style={{ height: "460px" }}>Surface scroller</div>
      </div>

      {/* 3. Outer transcript scroller with nested scrollable <pre> */}
      <div
        id="transcript-scroller"
        class="transcript h-48 w-72 overflow-y-auto border border-border bg-background p-3 text-xs text-fg"
      >
        <p id="transcript-para" class="mb-3 h-10 bg-surface-subtle p-2">
          Outer paragraph
        </p>
        <pre
          id="nested-pre"
          class="mb-3 h-24 w-56 overflow-auto border border-border bg-surface-subtle p-2 font-mono text-xs"
        >
          <code style={{ display: "block", width: "520px", height: "280px" }}>
            Nested code
          </code>
        </pre>
        <div style={{ height: "480px" }}>Bottom spacer</div>
      </div>

      {/* 4. Intentional hidden-scrollbar strips */}
      <div class="flex flex-col gap-2">
        <div
          id="hidden-no-scrollbar"
          class="no-scrollbar flex h-9 w-44 items-center gap-2 overflow-x-auto border border-border bg-surface px-2 text-xs"
        >
          <div style={{ width: "480px", "flex-shrink": "0" }}>no-scrollbar strip items</div>
        </div>
        <div id="hidden-segmented" class="ui-segmented w-44">
          <button type="button" class="ui-segment" aria-pressed="true">Segment Alpha</button>
          <button type="button" class="ui-segment">Segment Beta</button>
          <button type="button" class="ui-segment">Segment Gamma</button>
        </div>
        <div id="hidden-tabs" class="ui-tabs-list w-44">
          <button type="button" class="ui-segment" aria-selected="true">Tab One</button>
          <button type="button" class="ui-segment">Tab Two</button>
          <button type="button" class="ui-segment">Tab Three</button>
        </div>
        <div
          id="hidden-tailwind"
          class="flex h-9 w-44 items-center gap-2 overflow-x-auto border border-border bg-surface px-2 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div style={{ width: "480px", "flex-shrink": "0" }}>tailwind hidden strip</div>
        </div>
      </div>

      {/* 5. Generative UI widget iframe */}
      <iframe
        id="widget-iframe"
        title="Generative UI widget"
        sandbox="allow-scripts"
        srcdoc={widgetSrcDoc}
        class="h-40 w-64 border border-border bg-surface"
      />
    </div>
  );

  return (
    <>
      <Show when={extraScope()}>
        <ExtraScopeProbe />
      </Show>

      <Show
        when={mode() === "code"}
        fallback={
          <div class="gw-shell min-h-screen bg-background text-fg">
            <div
              id="gateway-scroller"
              class="m-4 h-40 w-56 overflow-y-auto border border-border bg-surface p-3 text-xs text-fg"
            >
              <div style={{ height: "460px" }}>Gateway scroller</div>
            </div>
          </div>
        }
      >
        <WorkspaceShell>
          {workspaceBody()}
          <Show when={portalOpen()}>
            <Portal>
              <div
                id="portal-dialog-body"
                class="ui-dialog-body fixed right-6 bottom-6 z-50 h-36 w-56 overflow-y-auto border border-border bg-surface-raised p-3 text-xs text-fg"
              >
                <div style={{ height: "420px" }}>Dialog body</div>
              </div>
              <div
                id="portal-popover"
                class="ui-popover ui-menu fixed right-72 bottom-6 z-50 h-36 w-52 overflow-y-auto p-2 text-xs text-fg"
              >
                <div style={{ height: "420px" }}>Popover menu</div>
              </div>
            </Portal>
          </Show>
        </WorkspaceShell>
      </Show>
    </>
  );
}

render(() => <ScrollbarsFixture />, document.getElementById("root")!);
