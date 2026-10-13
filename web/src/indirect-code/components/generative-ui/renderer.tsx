import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import {
  attachGuBridge,
  clampFrameHeight,
  widgetTheme,
} from "./bridge";
import { processPartialHtml } from "./process-partial-html";
import { parseGenerativeUiDsl, hasWidgetBody, type GenerativeUiData } from "./dsl";

/**
 * Generative UI widget (ported from OpenIntelligentUI renderer.tsx to Solid).
 *
 * The widget is a markdown DSL (```generative_ui fenced block). Rendering
 * runs in two stages:
 *
 *  - while the assistant streams the block, a *preview* iframe (served by
 *    /api/indirect-code/gen-ui/preview) morphs the partial HTML in place —
 *    Idiomorph preserves DOM state and focus across every token;
 *  - when the block closes, the body is uploaded to
 *    /api/indirect-code/gen-ui/widgets and the *final* iframe loads that
 *    document: the real sandboxed widget (runtime + @js + d3), interactive,
 *    isolated and offline.
 *
 * Why URLs instead of srcdoc: the gateway CSP is frame-src allowlist with
 * no 'unsafe-inline' — inline frames inherit it and their inline scripts
 * are refused. Served documents carry their own strict CSP header
 * (sandbox allow-scripts; default-src 'none') and work in any embedder.
 */
export function GenerativeUiWidget(props: {
  /** Raw fenced block body (may be partial while streaming). */
  body: () => string;
  /** True while the assistant is still streaming this block. */
  streaming: () => boolean;
  onSendPrompt: (text: string) => void;
  onOpenLink?: (url: string) => void;
}) {
  const [previewEl, setPreviewEl] = createSignal<HTMLIFrameElement>();
  const [finalEl, setFinalEl] = createSignal<HTMLIFrameElement>();
  const [finalUrl, setFinalUrl] = createSignal<string>("");
  const [finalHeight, setFinalHeight] = createSignal<number>(0);
  const [theme, setTheme] = createSignal(widgetTheme());

  const streaming = () => props.streaming();
  const data = (): GenerativeUiData => parseGenerativeUiDsl(props.body());
  const rootHeight = () => {
    const h = Number(data().height) || 320;
    return clampFrameHeight(h > 0 ? h : 320);
  };
  const stateJSON = () => JSON.stringify(data().state ?? {});

  onMount(() => {
    const observer = new MutationObserver(() => setTheme(widgetTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    onCleanup(() => observer.disconnect());
  });

  // ---- preview (streaming) ----
  let previewDirty = false;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const pushPreview = () => {
    previewTimer = undefined;
    const win = previewEl()?.contentWindow;
    if (!win) return;
    const d = data();
    win.postMessage(
      { __guPreview: true, html: processPartialHtml(d.html || ""), css: d.css || "" },
      "*",
    );
  };
  // The preview frame's listener only attaches on load: re-push the latest
  // fragment on load so a fast stream can never outrun the frame boot.
  const onPreviewLoad = () => pushPreview();
  const schedulePreview = () => {
    previewDirty = true;
    if (previewTimer) return;
    previewTimer = setTimeout(() => {
      if (!previewDirty) return;
      previewDirty = false;
      pushPreview();
    }, 120);
  };

  const previewSrc = () =>
    `/api/indirect-code/gen-ui/preview?theme=${theme() === "light" ? "light" : "dark"}`;

  // ---- final widget ----
  let publishInFlight = false;
  const finalize = async () => {
    const d = data();
    if (!d.html || publishInFlight) return;
    publishInFlight = true;
    try {
      const res = await fetch("/api/indirect-code/gen-ui/widgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme: theme(),
          html: processPartialHtml(d.html),
          css: d.css || "",
          js: d.js || "",
          stateJSON: stateJSON(),
          initialHeight: rootHeight(),
          libs: d.libs && d.libs.length ? d.libs : ["d3"],
          net: d.net === true,
        }),
      });
      const out = await res.json().catch(() => null);
      if (res.ok && out?.url) {
        setFinalUrl(out.url as string);
        setFinalHeight(rootHeight());
      }
    } catch {
      // The widget stays on its placeholder if the upload fails.
    } finally {
      publishInFlight = false;
    }
  };

  createEffect(
    on(
      () => [data().html, data().css, data().js, stateJSON(), theme(), streaming(), (data().libs || []).join(","), data().net ? 1 : 0] as const,
      ([, , , , , stillStreaming]) => {
        if (stillStreaming) return;
        void finalize();
      },
    ),
  );

  createEffect(
    on(
      () => [data().html, data().css, theme()] as const,
      () => {
        if (!streaming()) return;
        schedulePreview();
      },
    ),
  );

  onMount(() => {
    const detach = attachGuBridge(
      () => (streaming() ? previewEl()?.contentWindow : finalEl()?.contentWindow),
      {
        onSendPrompt: (text) => props.onSendPrompt(text),
        onOpenLink: (url) => {
          if (props.onOpenLink) props.onOpenLink(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        },
        onResize: (height) => setFinalHeight(height),
      },
    );
    onCleanup(detach);
  });

  return (
    <Show when={hasWidgetBody(data()) || streaming()}>
      {/* One surface only: the host card and the widget document share the
          `card` token, so the frame seam is invisible. The streaming status
          floats over the preview instead of pushing it down (no layout jump
          when the final widget swaps in). */}
      <div class="gu-card-host relative overflow-hidden rounded-[14px] border border-line bg-card shadow-[0_1px_3px_rgb(0_0_0/4%)]">
        <Show when={streaming() || !finalUrl()}>
          <div class="pointer-events-none absolute top-2.5 right-2.5 z-10 flex max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-full border border-line bg-elev/90 py-1 pr-2.5 pl-2 shadow-sm backdrop-blur">
            <span class="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-500 border-t-transparent" />
            <span class="truncate text-[11px] font-medium text-ink-400">
              {data().placeholder || "Building your widget"}
            </span>
          </div>
        </Show>
        <Show
          when={!streaming() && !!finalUrl()}
          fallback={
            <iframe
              ref={setPreviewEl}
              sandbox="allow-scripts"
              referrerpolicy="no-referrer"
              title="Interactive widget"
              src={previewSrc()}
              onLoad={onPreviewLoad}
              class="block w-full border-0 bg-card"
              style={{ height: `${rootHeight()}px` }}
            />
          }
        >
          <iframe
            ref={setFinalEl}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            title="Interactive widget"
            src={finalUrl()}
            class="block w-full border-0 bg-card transition-[height] duration-200 ease-out motion-reduce:transition-none"
            style={{ height: `${clampFrameHeight(finalHeight() || rootHeight())}px` }}
          />
        </Show>
      </div>
    </Show>
  );
}

export { parseGenerativeUiDsl };
export type { GenerativeUiData };
