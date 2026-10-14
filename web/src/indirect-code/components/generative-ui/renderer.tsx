import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { MsgIconBtn } from "../MsgActions";
import { claimLiveWidget, releaseLiveWidget } from "./widget-live";

import {
  attachGuBridge,
  clampFrameHeight,
  MIN_FRAME_HEIGHT,
  widgetTheme,
} from "./bridge";
import { parseGenerativeUiDsl, type GenerativeUiData } from "./dsl";
import { fetchWidgetSource, invalidateWidgetSources, widgetSourceVersion } from "./widget-source";

/**
 * Host renderer of a ```generative_ui fence.
 *
 * The fence carries HEADER LINES ONLY (placeholder / state / widget_id). The
 * widget's TSX source lives in the session's widget store (widget_set
 * tool); the fence links it by `widget_id:`. Rendering:
 *
 *  - fence with `widget_id:` + relay ctx → fetch the stored source (WS
 *    get_widget), publish it into the content-addressed gateway store and
 *    mount the sandboxed iframe document.
 *  - fence without `widget_id:` (or no relay ctx) → static card with the
 *    placeholder + default state preview (no frame).
 *
 * State: the widget's explicit `window.__gu.saveState()` hook persists to
 * localStorage (per host + session + widget id) — non-reactive, only when
 * the widget asks. On load the saved state wins over the fence `state:`
 * default.
 */
export function GenerativeUiWidget(props: {
  /** Fence body (header lines), a signal so streaming updates re-parse. */
  body: () => string;
  /** True while the fence is still streaming. */
  streaming: () => boolean;
  /**
   * True for EARLIER duplicates of a widget id whose last fence is another
   * instance in the same transcript: those stay unloaded (no iframe, no
   * lib fetch) until the user mounts them manually.
   */
  frozen?: () => boolean;
  onSendPrompt: (text: string) => void;
  onPrefillPrompt?: (text: string) => void;
  onOpenLink?: (url: string) => void;
  /** Relay access for fetching widget sources (absent = static card). */
  ctx?: {
    send: (payload: { type: "get_widget"; sessionId: string; requestId: string; widgetId: string }) => void;
    hostId: string;
    sessionId: string;
  };
}) {
  const MIN_START_HEIGHT = 96;
  const [finalEl, setFinalEl] = createSignal<HTMLIFrameElement | null>(null);
  const [finalUrl, setFinalUrl] = createSignal<string>("");
  const [finalHeight, setFinalHeight] = createSignal<number>(0);
  const [error, setError] = createSignal<string>("");
  const [theme, setTheme] = createSignal(widgetTheme());
  const [unfrozen, setUnfrozen] = createSignal(false);
  const [deactivated, setDeactivated] = createSignal(false);
  const [superseded, setSuperseded] = createSignal(false);
  /** Immersive fullscreen overlay (games/3D widgets on small screens). */
  const [expanded, setExpanded] = createSignal(false);
  /**
   * Unloaded: superseded by a newer fence for the same widget id (registry),
   * an earlier duplicate in document order (prop), or user-deactivated.
   * A manual Load overrides both duplicate signals.
   */
  const frozen = () =>
    deactivated() || (!unfrozen() && (superseded() || (props.frozen?.() ?? false)));
  const reactivate = () => {
    setDeactivated(false);
    setUnfrozen(true);
    void finalize();
  };
  /** Hard reload: re-fetch the source from the daemon, then republish (fresh
   *  mount). Works even when the source is missing/stale — that is exactly
   *  the case the button is needed for. */
  const reload = async () => {
    if (frozen()) return;
    const id = data().id;
    if (!id || !props.ctx) return;
    // Drop the published doc + the cached source so finalize really
    // re-POSTs (the content-addressed publish key would otherwise no-op).
    publishedKey = "";
    setFinalUrl("");
    invalidateWidgetSources(props.ctx!.sessionId, id);
    const rec = await fetchWidgetSource(props.ctx!.send, props.ctx!.hostId, props.ctx!.sessionId, id);
    if (rec?.source) {
      setMissing(false);
      setSource(rec.source);
    } else {
      setMissing(true);
      setSource("");
    }
    forcePublish = true;
    void finalize();
  };

  // Escape exits the fullscreen overlay; auto-exit when the widget unloads.
  createEffect(() => {
    if (!expanded()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  createEffect(() => {
    if (frozen() && expanded()) setExpanded(false);
  });

  const streaming = () => props.streaming();
  // Memoized-ish: parse once per body change (accessors are read often
  // during streaming).
  let parsedCache: { raw: string; data: GenerativeUiData } | null = null;
  const data = (): GenerativeUiData => {
    const raw = props.body();
    if (!parsedCache || parsedCache.raw !== raw) parsedCache = { raw, data: parseGenerativeUiDsl(raw) };
    return parsedCache.data;
  };

  /**
   * Saved state lookup: keyed by host + session + widget id only. There is
   * deliberately NO id-only fallback — a widget's state belongs to the exact
   * session it was created in (a same-id widget in another session must not
   * inherit it).
   */
  const stateKey = (id: string): string => {
    const c = props.ctx;
    return c ? `gu:state:${c.hostId}:${c.sessionId}:${id}` : `gu:state:::${id}`;
  };
  const readSavedState = (id: string): string | null => {
    try {
      return window.localStorage.getItem(stateKey(id));
    } catch {
      return null;
    }
  };
  const writeSavedState = (id: string, stateJSON: string): void => {
    try {
      window.localStorage.setItem(stateKey(id), stateJSON);
    } catch {}
  };

  onMount(() => {
    const observer = new MutationObserver(() => setTheme(widgetTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    onCleanup(() => observer.disconnect());
  });

  // ---- one live instance per widget id (transcript-wide) ----
  // Claim order is effect order (document order): the newest fence for an
  // id wins, earlier ones go superseded; releasing the active one (message
  // deleted, session switch) reactivates the newest survivor.
  {
    const token = Symbol("gu-live");
    let claimed = "";
    createEffect(
      on(
        () => data().id,
        (id) => {
          const wid = id ?? "";
          if (wid === claimed) return;
          if (claimed) releaseLiveWidget(claimed, token);
          claimed = wid;
          if (wid) {
            claimLiveWidget(wid, {
              token,
              onSupersede: () => setSuperseded(true),
              onReactivate: () => setSuperseded(false),
            });
          }
        },
      ),
    );
    onCleanup(() => {
      if (claimed) releaseLiveWidget(claimed, token);
    });
  }

  // ---- source resolution (id → session widget store) ----
  const [source, setSource] = createSignal<string>("");
  const [missing, setMissing] = createSignal(false);
  createEffect(
    on(
      // widgetSourceVersion bumps on cache invalidation: the effect must
      // re-run so a dropped cache entry is actually re-fetched.
      () => [data().id, streaming(), widgetSourceVersion.get()] as const,
      ([id, stillStreaming]) => {
        if (!id || stillStreaming || !props.ctx || frozen()) return;
        // fetchWidgetSource serves the in-memory cache when present (a
        // version bump only re-runs this for the widget whose entry was
        // dropped — the others resolve from cache, no WS round-trip).
        void fetchWidgetSource(props.ctx!.send, props.ctx!.hostId, props.ctx!.sessionId, id).then((rec) => {
          if (rec?.source) {
            setMissing(false);
            setSource(rec.source);
          } else {
            setMissing(true);
            setSource("");
          }
        });
      },
    ),
  );

  // Effective state: the widget's saved state wins over the fence default.
  const stateJSON = () => {
    const d = data();
    const saved = d.id ? readSavedState(d.id) : null;
    if (saved) return saved;
    return JSON.stringify(d.state ?? {});
  };

  /** Dedupe key for publish: identical theme+state+source never re-POSTs. */
  const widgetKey = () => `${theme()}\u0000${stateJSON()}\u0000${source()}`;

  // ---- final widget ----
  let publishInFlight = false;
  let publishedKey = "";
  /** Set by reload(): the next publish must not dedupe by content key. */
  let forcePublish = false;
  const finalize = async () => {
    const d = data();
    if (!d.id || !source() || publishInFlight || frozen()) return;
    // Snapshot reconciliation can re-trigger this with semantically identical
    // content (escaped text resolves, footers strip): publishing the same
    // content again is a no-op worth keeping — a second POST would only
    // return the same content-addressed URL. An explicit reload overrides
    // the dedupe so the iframe document is rebuilt from scratch.
    const key = widgetKey();
    if (!forcePublish && key === publishedKey && finalUrl()) return;
    publishInFlight = true;
    try {
      const res = await fetch("/api/indirect-code/gen-ui/widgets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          theme: theme(),
          jsx: source(),
          stateJSON: stateJSON(),
        }),
      });
      const out = await res.json().catch(() => null);
      if (res.ok && out?.url) {
        publishedKey = key;
        forcePublish = false;
        const resolved = resolvePublishedFrame({
          nextUrl: out.url as string,
          currentUrl: finalUrl(),
          currentHeight: finalHeight(),
          cachedHeight: frameHeights.get(out.url as string),
        });
        setFinalUrl(resolved.url);
        setFinalHeight(resolved.height);
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
      () => [source(), stateJSON(), theme(), streaming()] as const,
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
        onPrefillPrompt: (text) => props.onPrefillPrompt?.(text),
        onOpenLink: (url) => {
          if (props.onOpenLink) props.onOpenLink(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        },
        onResize: (height) => {
          const url = finalUrl();
          if (url) frameHeights.set(url, height);
          setFinalHeight(height);
        },
        onError: (message) => setError(message),
        // Explicit save hook (window.__gu.saveState) — never reactive.
        onState: (stateJSON) => {
          const id = data().id;
          if (id) writeSavedState(id, stateJSON);
        },
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

  const isStatic = () => !data().id || (!props.ctx && !streaming());

  return (
    <>
      {/* One surface only: the host card and the widget document share the
          `card` token, so the frame seam is invisible. While the widget is
          not ready, a centered loading pill (placeholder text) floats over
          the streaming preview; runtime errors land in the footer below. */}
      <div class={expanded() ? "group/guhost fixed inset-0 z-[55] flex flex-col overflow-hidden bg-ink-950/95" : "group/guhost"}>
        <Show when={!streaming()}>
          <div
            class={
              expanded()
                ? "pointer-events-none flex items-center justify-end gap-1 p-2"
                /* max-md: opacity-100 — no hover on touch screens, so the
                   reload/fullscreen/unload controls must always show there. */
                : "pointer-events-none -mb-1 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/guhost:opacity-100 focus-within:opacity-100 max-md:opacity-100"
            }
          >
            <div class="pointer-events-auto flex items-center gap-0.5">
              <Show
                when={!frozen()}
                fallback={<MsgIconBtn tip="Load this widget" icon="lucide:play" compact onClick={reactivate} />}
              >
                <MsgIconBtn tip="Reload widget" icon="lucide:refresh-cw" compact onClick={reload} />
                <MsgIconBtn
                  tip={expanded() ? "Exit fullscreen" : "Fullscreen widget"}
                  icon={expanded() ? "lucide:minimize" : "lucide:maximize"}
                  compact
                  onClick={() => setExpanded(!expanded())}
                />
                <MsgIconBtn
                  tip="Unload widget"
                  icon="lucide:eye-off"
                  compact
                  onClick={() => {
                    setExpanded(false);
                    setDeactivated(true);
                  }}
                />
              </Show>
            </div>
          </div>
        </Show>
        <div
          class={
            expanded()
              ? "relative min-h-0 flex-1 overflow-hidden"
              : "gu-card-host relative mb-3 overflow-hidden rounded-[14px] border border-line bg-card shadow-[0_1px_3px_rgb(0_0_0/4%)]"
          }
        >
        <Show when={frozen() && !streaming()}>
          <div class="ui-card-mode flex items-center justify-center gap-2 px-3 py-1.5">
            <span class="truncate text-[11px] text-ink-500 gu-mono">{data().id || "widget"}</span>
            <button
              type="button"
              class="ui-button ui-button-sm ui-button-outline cursor-pointer"
              onClick={reactivate}
            >
              Load
            </button>
          </div>
        </Show>
        <Show when={!frozen() && (streaming() || (!finalUrl() && !isStatic() && !missing())) && !error()}>
          <div class="pointer-events-none absolute inset-0 z-10 grid place-items-center p-4">
            <div class="flex max-w-full items-center gap-2 rounded-full border border-line bg-elev/90 py-1.5 pr-3.5 pl-3 shadow-sm backdrop-blur">
              <span class="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-500 border-t-transparent" />
              <span class="truncate text-[11px] font-medium text-ink-400">
                {data().placeholder || "Building your widget"}
              </span>
            </div>
          </div>
        </Show>
        <Show when={missing()}>
          <div class="ui-card-mode flex items-center gap-2 px-3 py-1.5">
            <span class="shrink-0 text-[11px] font-semibold text-rose-500">Widget not found</span>
            <span class="min-w-0 flex-1 truncate text-[11px] text-ink-500 gu-mono">{data().id}</span>
            <Show when={props.onPrefillPrompt}>
              <button
                type="button"
                class="ui-button ui-button-sm ui-button-outline shrink-0 cursor-pointer"
                onClick={() => props.onPrefillPrompt?.(`The widget with id "${data().id}" is referenced by a generative_ui fence but has no stored source. Store it with widget_set (id: "${data().id}").`)}
              >
                Ask to fix
              </button>
            </Show>
          </div>
        </Show>
        <Show when={isStatic() && !streaming() && !missing()}>
          <div class="ui-card-mode p-4">
            <div class="text-[11px] font-semibold text-ink-300">{data().placeholder || "Interactive widget"}</div>
            <Show when={Object.keys(data().state ?? {}).length}>
              <pre class="mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-elev/40 p-2 text-[11px] text-ink-400">
                {JSON.stringify(data().state ?? {}, null, 2)}
              </pre>
            </Show>
            <div class="mt-2 text-[11px] text-ink-500">
              Static preview — this fence has no <code>widget_id:</code> link to a stored widget source.
            </div>
          </div>
        </Show>
        <Show
          when={!frozen() && !streaming() && !!finalUrl()}
          fallback={
            /* Widgets compile at publish time: this thin inert surface keeps
               the placeholder visible while streaming/loading; the frame
               grows to fit the mounted widget (bridge resize). Never when
               the widget is unloaded (frozen), missing or static — those
               states render their own compact card. */
            <Show when={!frozen() && !missing() && !isStatic() && !error()}>
              <div class="block w-full border-0 bg-card" style={{ height: `${MIN_START_HEIGHT}px` }} />
            </Show>
          }
        >
          <iframe
            ref={setFinalEl}
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            title="Interactive widget"
            src={finalUrl()}
            class={
              expanded()
                ? "block h-full w-full border-0 bg-card"
                : "block w-full border-0 bg-card transition-[height] duration-200 ease-out motion-reduce:transition-none"
            }
            style={
              expanded()
                ? { height: "100%" }
                : { height: `${clampFrameHeight(finalHeight() || MIN_START_HEIGHT)}px` }
            }
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
      </div>
    </>
  );
}

/**
 * Keeps the previously painted height while the same widget is republished
 * (same content-addressed URL family) so an update never flashes the thin
 * loading state again.
 */
function resolvePublishedFrame(params: {
  nextUrl: string;
  currentUrl: string;
  currentHeight: number;
  cachedHeight: number | undefined;
}): { url: string; height: number } {
  const { nextUrl, currentUrl, currentHeight, cachedHeight } = params;
  if (nextUrl === currentUrl) return { url: nextUrl, height: currentHeight || cachedHeight || MIN_FRAME_HEIGHT };
  return { url: nextUrl, height: cachedHeight ?? MIN_FRAME_HEIGHT };
}

const frameHeights = new Map<string, number>();

export { parseGenerativeUiDsl };
export type { GenerativeUiData };
