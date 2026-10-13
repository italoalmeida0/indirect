import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import {
  attachGuBridge,
  clampFrameHeight,
  MIN_FRAME_HEIGHT,
  widgetTheme,
} from "./bridge";

/** The frame starts this thin and grows to the widget's measured content. */
const MIN_START_HEIGHT = MIN_FRAME_HEIGHT;
import { parseGenerativeUiDsl, hasWidgetBody, type GenerativeUiData } from "./dsl";

/**
 * Generative UI widget (React `@jsx` widgets).
 *
 * The widget is a markdown DSL (```generative_ui fenced block): header keys,
 * then one React component. Rendering runs in two stages:
 *
 *  - while the assistant streams the block, the placeholder pill covers an
 *    inert surface — the source is compiled once, when the block closes;
 *  - when the block closes, the body is uploaded to
 *    /api/indirect-code/gen-ui/widgets (compiled server-side with sucrase)
 *    and the *final* iframe loads that document: the real sandboxed widget
 *    (React runtime + compiled module + libs), interactive and isolated
 *    (network: images, plus https/esm.sh with `net: true`).
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
  /** Paste text into the composer without sending (error reports). */
  onPrefillPrompt?: (text: string) => void;
  onOpenLink?: (url: string) => void;
}) {
  const [finalEl, setFinalEl] = createSignal<HTMLIFrameElement>();
  const [finalUrl, setFinalUrl] = createSignal<string>("");
  const [finalHeight, setFinalHeight] = createSignal<number>(0);
  const [error, setError] = createSignal<string>("");
  const [theme, setTheme] = createSignal(widgetTheme());

  const streaming = () => props.streaming();
  // Memoized: parse once per body change, not once per accessor read (the
  // effects and JSX below read data() many times per token while streaming).
  const data = createMemo<GenerativeUiData>(() => parseGenerativeUiDsl(props.body()));
  // The frame starts thin and grows to fit content: the widget reports its
  // real height over the bridge (clamped), so no height bookkeeping is needed
  // in the DSL.
  const stateJSON = () => JSON.stringify(data().state ?? {});

  onMount(() => {
    const observer = new MutationObserver(() => setTheme(widgetTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    onCleanup(() => observer.disconnect());
  });

  // ---- final widget ----
  let publishInFlight = false;
  const finalize = async () => {
    const d = data();
    if (!d.jsx || publishInFlight) return;
    publishInFlight = true;
    try {
      const res = await fetch("/api/indirect-code/gen-ui/widgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme: theme(),
          jsx: d.jsx,
          stateJSON: stateJSON(),
        }),
      });
      const out = await res.json().catch(() => null);
      if (res.ok && out?.url) {
        setFinalUrl(out.url as string);
        setFinalHeight(0); // grow from the widget's own measurement
        setError("");
      } else {
        setError(`Widget could not be published (HTTP ${res.status}).`);
      }
    } catch {
      setError("Widget could not be published (network error).");
    } finally {
      publishInFlight = false;
    }
  };

  createEffect(
    on(
      () => [data().jsx, stateJSON(), theme(), streaming()] as const,
      ([, , , stillStreaming]) => {
        if (stillStreaming) return;
        void finalize();
      },
    ),
  );

  onMount(() => {
    const detach = attachGuBridge(
      () => (streaming() ? undefined : finalEl()?.contentWindow),
      {
        onSendPrompt: (text) => props.onSendPrompt(text),
        onOpenLink: (url) => {
          if (props.onOpenLink) props.onOpenLink(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        },
        onResize: (height) => setFinalHeight(height),
        onError: (message) => setError(message),
      },
    );
    onCleanup(detach);
  });

  /** Short content-hash ref from the published widget URL (error reports). */
  const widgetRef = () => finalUrl().split("/").pop()?.slice(0, 12) || "";
  const reportText = () => {
    const label = data().placeholder || "Interactive widget";
    const ref = widgetRef();
    return [
      `The "${label}" widget${ref ? ` (ref ${ref})` : ""} failed with this error:`,
      "",
      error(),
      "",
      "Please fix the widget and regenerate it.",
    ].join("\n");
  };

  return (
    <Show when={hasWidgetBody(data()) || streaming()}>
      {/* One surface only: the host card and the widget document share the
          `card` token, so the frame seam is invisible. While the widget is
          not ready, a centered loading pill (placeholder text) floats over
          the streaming preview; runtime errors land in the footer below. */}
      <div class="gu-card-host relative mb-3 overflow-hidden rounded-[14px] border border-line bg-card shadow-[0_1px_3px_rgb(0_0_0/4%)]">
        <Show when={(streaming() || !finalUrl()) && !error()}>
          <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center p-4">
            <div class="flex max-w-full items-center gap-2 rounded-full border border-line bg-elev/90 py-1.5 pr-3.5 pl-3 shadow-sm backdrop-blur">
              <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-500 border-t-transparent" />
              <span class="truncate text-[11px] font-medium text-ink-400">
                {data().placeholder || "Building your widget"}
              </span>
            </div>
          </div>
        </Show>
        <Show
          when={!streaming() && !!finalUrl()}
          fallback={
            /* Widgets compile at publish time: this thin inert surface keeps
               the placeholder visible while streaming; the frame grows to
               fit the mounted widget (bridge resize). */
            <div class="block w-full border-0 bg-card" style={{ height: `${MIN_START_HEIGHT}px` }} />
          }
        >
          <iframe
            ref={setFinalEl}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            title="Interactive widget"
            src={finalUrl()}
            class="block w-full border-0 bg-card transition-[height] duration-200 ease-out motion-reduce:transition-none"
            style={{ height: `${clampFrameHeight(finalHeight() || MIN_START_HEIGHT)}px` }}
          />
        </Show>
        <Show when={error()}>
          <div class="flex items-center gap-2 border-t border-line bg-elev/60 px-3 py-2">
            <span class="shrink-0 text-[11px] font-semibold text-rose-500">Widget error</span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-ink-400" title={error()}>
              {error()}
            </span>
            <Show when={props.onPrefillPrompt}>
              <button
                type="button"
                class="ui-button ui-button-sm ui-button-outline shrink-0 cursor-pointer"
                onClick={() => props.onPrefillPrompt?.(reportText())}
              >
                Ask to fix
              </button>
            </Show>
            <button
              type="button"
              aria-label="Dismiss error"
              class="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[13px] leading-none text-ink-500 hover:bg-ink-800/60 hover:text-ink-200"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}

export { parseGenerativeUiDsl };
export type { GenerativeUiData };
