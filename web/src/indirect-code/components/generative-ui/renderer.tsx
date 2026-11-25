import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { authHeaders } from "../../../api";
import { Icon } from "../../../components/icon";
import { lockScroll, pushLayer } from "../../../ds/primitives/layers";
import { copyToClipboard } from "../../../ui";
import { MsgIconBtn } from "../MsgActions";
import { useModal } from "../../ctx";
import { claimLiveWidget, releaseLiveWidget } from "./widget-live";
import { registerFullscreenWidget } from "./fullscreen-state";
import { CodeBlock } from "../CodeBlock";

import {
  attachGuBridge,
  clampFrameHeight,
  createWidgetPublishController,
  parseSavedStateJSON,
  postGuAiContext,
  postGuAiEvent,
  postGuAttachments,
  postGuFullscreen,
  postGuTheme,
  resolveWidgetStateJSON,
  widgetAccent,
  widgetTheme,
  type WidgetAiContext,
  type WidgetAttachPayload,
  type WidgetAttachmentSummary,
} from "./bridge";
import { createWidgetAiController } from "./ai-client";
import { parseGenerativeUiDsl, type GenerativeUiData } from "./dsl";
import { resolvePublishedFrame } from "./frame-height";
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
  /** Stable segment fallback identifier for widget-owned composer attachments. */
  ownerKey?: string;
  onAttach?: (owner: string, payload: WidgetAttachPayload) => void;
  onDetach?: (owner: string, key?: string) => void;
  widgetAttachments?: (owner: string) => WidgetAttachmentSummary[];
  aiContext?: () => (WidgetAiContext & { hostId?: string }) | undefined;
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
  const [accent, setAccent] = createSignal(widgetAccent());
  const [unfrozen, setUnfrozen] = createSignal(false);
  const [deactivated, setDeactivated] = createSignal(false);
  const [superseded, setSuperseded] = createSignal(false);
  const [showSource, setShowSource] = createSignal(false);
  const [copiedSource, setCopiedSource] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));
  const liveToken = Symbol("gu-live");
  /** Immersive fullscreen overlay (games/3D widgets on small screens). */
  const [expanded, setExpanded] = createSignal(false);
  /** Narrow/mobile viewport: dock the host toolbar above the frame so it never covers widget HUDs. */
  const [narrow, setNarrow] = createSignal(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 639px)").matches
      : false,
  );
  /** Global confirm modal (promise-based) for the destructive reset. */
  const modal = useModal();
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
    setSuperseded(false);
    const wid = data().id;
    if (wid) {
      claimLiveWidget(
        wid,
        {
          token: liveToken,
          onSupersede: () => {
            setUnfrozen(false);
            setSuperseded(true);
          },
          onReactivate: () => setSuperseded(false),
        },
        props.ctx?.sessionId,
      );
    }
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
    publisher.invalidate();
    invalidateWidgetSources(props.ctx!.sessionId, id);
    const rec = await fetchWidgetSource(props.ctx!.send, props.ctx!.hostId, props.ctx!.sessionId, id);
    if (rec?.source) {
      setMissing(false);
      setSource(rec.source);
    } else {
      setMissing(true);
      setSource("");
      publisher.invalidate();
      return;
    }
    void finalize();
  };

  // Escape and Browser Back exit the fullscreen overlay via the shared layer
  // and navigation stacks; auto-exit when the widget unloads.
  let hostRootEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (!expanded()) return;
    const unregisterNav = registerFullscreenWidget(() => setExpandedSync(false));
    const removeLayer = pushLayer({
      kind: "popover",
      contains: (node) => Boolean(hostRootEl?.contains(node)),
      onEscape: () => {
        setExpandedSync(false);
      },
    });
    const unlock = lockScroll();
    onCleanup(() => {
      unregisterNav();
      removeLayer();
      unlock();
    });
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
  /** Saved snapshot for this widget (null = none): drives the reset control. */
  const [savedState, setSavedState] = createSignal<string | null>(null);
  const readSavedState = (id: string): string | null => {
    try {
      const raw = window.localStorage.getItem(stateKey(id));
      const parsed = parseSavedStateJSON(raw);
      return parsed ? JSON.stringify(parsed) : null;
    } catch {
      return null;
    }
  };
  const writeSavedState = (id: string, stateJSON: string): void => {
    const parsed = parseSavedStateJSON(stateJSON);
    if (!parsed) return;
    const normalized = JSON.stringify(parsed);
    try {
      window.localStorage.setItem(stateKey(id), normalized);
    } catch {}
    setSavedState(normalized);
  };
  const deleteSavedState = (id: string): void => {
    try {
      window.localStorage.removeItem(stateKey(id));
    } catch {}
    setSavedState(null);
  };

  onMount(() => {
    const syncHostAppearance = () => {
      setTheme(widgetTheme());
      setAccent(widgetAccent());
    };
    const observer = new MutationObserver(syncHostAppearance);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent", "class"],
    });
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      const mql = window.matchMedia("(max-width: 639px)");
      const onMediaChange = (ev: MediaQueryListEvent) => setNarrow(ev.matches);
      setNarrow(mql.matches);
      mql.addEventListener("change", onMediaChange);
      onCleanup(() => mql.removeEventListener("change", onMediaChange));
    }
    onCleanup(() => observer.disconnect());
  });

  const ownerId = () =>
    `${props.ctx?.sessionId || "local"}:${data().id || props.ownerKey || "widget"}`;
  const aiController = createWidgetAiController();
  onCleanup(() => aiController.abort());

  const syncFrameAttachments = (win: Window | null | undefined) => {
    if (!win || !props.widgetAttachments) return;
    postGuAttachments(win, props.widgetAttachments(ownerId()));
  };
  const syncFrameAiContext = (win: Window | null | undefined) => {
    if (!win || !props.aiContext) return;
    const ac = props.aiContext();
    if (!ac) return;
    postGuAiContext(win, {
      model: ac.model,
      modelName: ac.modelName,
      effort: ac.effort,
      efforts: ac.efforts,
      models: ac.models,
    });
  };
  const syncFrameAppearance = () => {
    const win = finalEl()?.contentWindow;
    postGuTheme(win, { theme: theme(), accent: accent() });
    postGuFullscreen(win, expanded());
    syncFrameAttachments(win);
    syncFrameAiContext(win);
  };
  createEffect(() => {
    const frame = finalEl();
    const curTheme = theme();
    const curAccent = accent();
    if (!frame) return;
    postGuTheme(frame.contentWindow, { theme: curTheme, accent: curAccent });
  });
  createEffect(() => {
    const frame = finalEl();
    const isExpanded = expanded();
    if (!frame) return;
    postGuFullscreen(frame.contentWindow, isExpanded);
  });
  createEffect(() => {
    const frame = finalEl();
    const list = props.widgetAttachments?.(ownerId());
    if (!frame || !list) return;
    postGuAttachments(frame.contentWindow, list);
  });
  createEffect(() => {
    const frame = finalEl();
    const ac = props.aiContext?.();
    if (!frame || !ac) return;
    postGuAiContext(frame.contentWindow, {
      model: ac.model,
      modelName: ac.modelName,
      effort: ac.effort,
      efforts: ac.efforts,
      models: ac.models,
    });
  });
  createEffect(
    on(
      () => [finalUrl(), frozen(), streaming(), expanded()] as const,
      ([, isFrozen, isStreaming]) => {
        if (isFrozen) setFinalEl(null);
        if (isFrozen || isStreaming) aiController.abort();
      },
    ),
  );
  createEffect(
    on(expanded, () => {
      // Toggling fullscreen remounts the iframe inside/outside Portal; abort
      // any in-flight AI stream owned by the dying frame immediately.
      aiController.abort();
      hasFrameInteracted = false;
    }, { defer: true }),
  );

  // ---- one live instance per session (transcript-wide) ----
  // Claim order is effect order (document order): the newest fence in the
  // session wins, earlier ones go superseded; releasing the active one
  // reactivates the newest survivor.
  {
    let claimed = "";
    createEffect(
      on(
        () => [data().id, props.ctx?.sessionId] as const,
        ([id, sessId]) => {
          const wid = id ?? "";
          if (wid === claimed) return;
          if (claimed) releaseLiveWidget(claimed, liveToken, sessId);
          claimed = wid;
          if (wid) {
            claimLiveWidget(
              wid,
              {
                token: liveToken,
                onSupersede: () => {
                  setUnfrozen(false);
                  setSuperseded(true);
                },
                onReactivate: () => setSuperseded(false),
              },
              sessId,
            );
          }
        },
      ),
    );
    onCleanup(() => {
      if (claimed) releaseLiveWidget(claimed, liveToken, props.ctx?.sessionId);
    });
  }

  // ---- source resolution (id → session widget store) ----
  const [source, setSource] = createSignal<string>("");
  const [missing, setMissing] = createSignal(false);
  const [sourceVer, setSourceVer] = createSignal(widgetSourceVersion.get());
  onMount(() => {
    setSourceVer(widgetSourceVersion.get());
    onCleanup(widgetSourceVersion.subscribe(setSourceVer));
  });
  createEffect(
    on(
      // sourceVer bumps on cache invalidation: the effect must re-run so a
      // dropped cache entry or late widget_data answer is actually picked up.
      () => [data().id, streaming(), sourceVer()] as const,
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
            publisher.invalidate();
          }
        });
      },
    ),
  );

  // Effective state: the widget's saved state wins over the fence default.
  // (readSavedState is the source of truth; the signal only drives the
  // reset-control visibility and re-syncs when the widget id changes.)
  createEffect(() => {
    const id = data().id;
    setSavedState(id ? readSavedState(id) : null);
  });
  const stateJSON = () => {
    const d = data();
    const saved = d.id ? readSavedState(d.id) : null;
    return resolveWidgetStateJSON(d.state, saved);
  };

  /** Reset to the fence default state and remount fresh — destructive (the
   *  saved snapshot is gone for good), so it always asks first. */
  const resetState = async () => {
    const id = data().id;
    if (!id) return;
    const ok = await modal.showConfirm({
      title: "Reset widget state?",
      message: "The saved state of this widget will be discarded and it will restart from its default state.",
      confirmText: "Reset state",
      danger: true,
    });
    if (!ok) return;
    deleteSavedState(id);
    // Drop the published URL before re-publishing: the content-addressed URL
    // for the default state often equals the original mount URL, so without
    // clearing finalUrl Solid would keep the stale in-memory iframe alive.
    publisher.invalidate();
    void finalize();
  };

  /** Dedupe key for publish: identical theme+state+source never re-POSTs. */
  const widgetKey = () => `${theme()}\u0000${stateJSON()}\u0000${source()}`;

  // ---- final widget ----
  const publisher = createWidgetPublishController({
    canPublish: () => !!data().id && !!source() && !frozen(),
    getKey: widgetKey,
    hasUrl: () => !!finalUrl(),
    clearUrl: () => setFinalUrl(""),
    publish: async () => {
      const res = await fetch("/api/indirect-code/gen-ui/widgets", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          theme: theme(),
          accent: untrack(accent),
          jsx: source(),
          stateJSON: stateJSON(),
        }),
      });
      const out = await res.json().catch(() => null);
      if (res.ok && out?.url) {
        return { ok: true, url: out.url as string };
      }
      return { ok: false, error: out?.error || `Widget could not be published (HTTP ${res.status}).` };
    },
    onSuccess: (url) => {
      const resolved = resolvePublishedFrame({
        nextUrl: url,
        currentUrl: finalUrl(),
        currentHeight: finalHeight(),
        cachedHeight: frameHeights.get(url),
      });
      setFinalUrl(resolved.url);
      setFinalHeight(resolved.height);
      setError("");
    },
    onError: (message) => setError(message),
  });
  onCleanup(() => publisher.dispose());
  const finalize = () => publisher.run();

  /**
   * Toggle fullscreen while preserving any state saved since the iframe was
   * mounted: switching into/out of Portal remounts the iframe, so if
   * localStorage now holds a newer snapshot than `publishedKey`, republish
   * before mounting the new iframe so progress never reverts.
   */
  const setExpandedSync = (next: boolean) => {
    if (next !== expanded()) {
      aiController.abort();
      hasFrameInteracted = false;
    }
    if (next !== expanded() && !frozen() && !streaming() && source() && widgetKey() !== publisher.publishedKey) {
      publisher.invalidate();
      void finalize();
    }
    setExpanded(next);
  };

  createEffect(
    on(
      () => [source(), stateJSON(), theme(), streaming()] as const,
      ([src, , , stillStreaming]) => {
        if (stillStreaming) return;
        if (!src) {
          publisher.invalidate();
          return;
        }
        void finalize();
      },
    ),
  );

  // Interaction tracking for widget-initiated sendPrompt: block immediate
  // mount-time auto-fire (< 500ms) and require host-observed focus or pointer
  // interaction with the iframe; otherwise downgrade to prefillPrompt so the
  // user sees the text before sending. (Never rely on parent userActivation,
  // which stays false when clicks happen inside an opaque-origin iframe.)
  const MIN_MOUNT_SETTLE_MS = 500;
  const INTERACTION_WINDOW_MS = 30_000;
  let frameMountedAt = 0;
  let lastFrameInteractionAt = 0;
  let hasFrameInteracted = false;
  createEffect(
    on(finalUrl, (url) => {
      aiController.abort();
      frameMountedAt = url ? Date.now() : 0;
      lastFrameInteractionAt = 0;
      hasFrameInteracted = false;
    }),
  );

  onMount(() => {
    const onWindowBlur = () => {
      const frame = finalEl();
      const now = Date.now();
      if (frame && document.activeElement === frame) {
        lastFrameInteractionAt = now;
        if (frameMountedAt > 0 && now - frameMountedAt >= MIN_MOUNT_SETTLE_MS) {
          hasFrameInteracted = true;
        }
      }
    };
    window.addEventListener("blur", onWindowBlur);
    const detach = attachGuBridge(
      () => (streaming() ? undefined : finalEl()?.contentWindow),
      {
        onSendPrompt: (text) => props.onSendPrompt(text),
        onPrefillPrompt: (text) => props.onPrefillPrompt?.(text),
        canAutoSend: () => {
          const now = Date.now();
          if (frameMountedAt === 0 || now - frameMountedAt < MIN_MOUNT_SETTLE_MS) return false;
          const frame = finalEl();
          const focused = !!frame && document.activeElement === frame;
          const recentInteraction =
            lastFrameInteractionAt > 0 && now - lastFrameInteractionAt <= INTERACTION_WINDOW_MS;
          return focused || recentInteraction;
        },
        onGesture: () => {
          hasFrameInteracted = true;
          lastFrameInteractionAt = Date.now();
        },
        canAttach: () => {
          if (frameMountedAt === 0) return false;
          if (hasFrameInteracted) return true;
          const now = Date.now();
          const frame = finalEl();
          if (frame && document.activeElement === frame && now - frameMountedAt >= MIN_MOUNT_SETTLE_MS) {
            hasFrameInteracted = true;
            lastFrameInteractionAt = now;
            return true;
          }
          return false;
        },
        canUseAi: () => {
          if (frameMountedAt === 0) return false;
          if (hasFrameInteracted) return true;
          const now = Date.now();
          const frame = finalEl();
          if (frame && document.activeElement === frame && now - frameMountedAt >= MIN_MOUNT_SETTLE_MS) {
            lastFrameInteractionAt = now;
            hasFrameInteracted = true;
            return true;
          }
          return false;
        },
        onOpenLink: (url) => {
          if (props.onOpenLink) props.onOpenLink(url);
          else window.open(url, "_blank", "noopener,noreferrer");
        },
        onResize: (height) => {
          if (expanded()) return;
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
        onReady: () => {
          syncFrameAppearance();
        },
        onEscape: () => {
          if (expanded()) setExpandedSync(false);
        },
        onAttach: (payload) => {
          props.onAttach?.(ownerId(), payload);
        },
        onDetach: (key) => {
          props.onDetach?.(ownerId(), key);
        },
        onAiRequest: props.aiContext
          ? (payload) => {
              const ac = untrack(() => props.aiContext?.());
              const targetWin = finalEl()?.contentWindow;
              if (!ac) {
                postGuAiEvent(targetWin, {
                  op: "aiError",
                  reqId: payload.reqId,
                  error: "Embedded AI is unavailable in this view.",
                  code: "ai_unavailable",
                });
                return;
              }
              aiController.start(payload, ac, (ev) => {
                // Never forward events from a superseded/remounted iframe into a new frame.
                const curWin = finalEl()?.contentWindow;
                if (curWin && curWin === targetWin) postGuAiEvent(curWin, ev);
              });
            }
          : undefined,
        onAiAbort: (reqId) => {
          aiController.abort(reqId);
        },
      },
    );
    onCleanup(() => {
      window.removeEventListener("blur", onWindowBlur);
      detach();
      aiController.abort();
    });
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
  const dockInlineToolbar = () => showSource() || missing() || narrow();

  const renderToolbarButtons = () => (
    <Show
      when={!frozen()}
      fallback={<MsgIconBtn tip="Load this widget" icon="lucide:play" compact onClick={reactivate} />}
    >
      <Show when={savedState() !== null}>
        <MsgIconBtn
          tip="Reset widget state"
          icon="lucide:rotate-ccw"
          compact
          onClick={resetState}
        />
      </Show>
      <Show when={!!source()}>
        <MsgIconBtn
          tip="Inspect source code"
          icon="lucide:code"
          compact
          onClick={() => setShowSource(!showSource())}
        />
      </Show>
      <MsgIconBtn tip="Reload widget" icon="lucide:refresh-cw" compact onClick={reload} />
      <MsgIconBtn
        tip={expanded() ? "Exit fullscreen" : "Fullscreen widget"}
        icon={expanded() ? "lucide:minimize" : "lucide:maximize"}
        compact
        onClick={() => setExpandedSync(!expanded())}
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
  );

  const renderCardContents = (isExpanded: boolean) => (
    <>
      <Show when={showSource() && !!source()}>
        <div class="shrink-0 border-b border-border-subtle bg-surface-subtle p-3 text-fg">
          <div class="mb-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs font-medium text-fg-secondary">Source code</span>
              <span class="rounded-inner bg-surface-muted px-1.5 py-0.5 font-mono tabular-nums text-2xs text-fg-muted truncate">
                {data().id}.tsx
              </span>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <MsgIconBtn
                tip={copiedSource() ? "Copied" : "Copy source code"}
                icon="lucide:copy"
                compact
                copied={copiedSource()}
                onClick={() => {
                  void copyToClipboard(source()).then((ok) => {
                    if (!ok) return;
                    setCopiedSource(true);
                    clearTimeout(copiedTimer);
                    copiedTimer = setTimeout(() => setCopiedSource(false), 2000);
                  });
                }}
              />
              <MsgIconBtn
                tip="Close source view"
                icon="lucide:x"
                compact
                onClick={() => setShowSource(false)}
              />
            </div>
          </div>
          <div class="max-h-80 overflow-auto rounded-inner border border-border bg-surface p-2 text-xs">
            <CodeBlock text={source()} language="tsx" wrap={false} maxH="max-h-72" />
          </div>
        </div>
      </Show>
      <Show when={frozen() && !streaming()}>
        <div class="flex items-center justify-center gap-2 px-10 py-1.5">
          <span class="truncate font-mono tabular-nums text-2xs text-fg-muted">{data().id || "widget"}</span>
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
          <div class="flex max-w-full items-center gap-2 rounded-pill border border-border bg-surface-raised shadow-resting py-1.5 pr-3.5 pl-3">
            <span class="h-3.5 w-3.5 shrink-0 ui-spinner text-fg-muted" />
            <span class="truncate text-2xs font-medium text-fg-secondary">
              {data().placeholder || "Building your widget"}
            </span>
          </div>
        </div>
      </Show>
      <Show when={missing()}>
        <div class="flex items-center gap-2 px-3 py-1.5">
          <span class="shrink-0 text-2xs font-medium text-danger">Widget not found</span>
          <span class="min-w-0 flex-1 truncate font-mono tabular-nums text-2xs text-fg-muted">{data().id}</span>
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
        <div class="p-4">
          <div class="text-2xs font-medium text-fg-secondary">{data().placeholder || "Interactive widget"}</div>
          <Show when={Object.keys(data().state ?? {}).length}>
            <pre class="mt-2 max-h-40 overflow-auto rounded-inner border border-border-subtle bg-surface-subtle p-2 font-mono text-2xs text-fg-secondary">
              {JSON.stringify(data().state ?? {}, null, 2)}
            </pre>
          </Show>
          <div class="mt-2 text-2xs text-fg-muted">
            Static preview · this fence has no <code>widget_id:</code> link to a stored widget source.
          </div>
        </div>
      </Show>
      <Show
        when={!frozen() && !streaming() && !missing() && !!finalUrl()}
        fallback={
          /* Widgets compile at publish time: this thin inert surface keeps
             the placeholder visible while streaming/loading; the frame
             grows to fit the mounted widget (bridge resize). Never when
             the widget is unloaded (frozen), missing or static — those
             states render their own compact card. */
          <Show when={!frozen() && !missing() && !isStatic() && !error()}>
            <div
              class={isExpanded ? "block min-h-0 w-full flex-1 border-0 bg-surface" : "block w-full border-0 bg-surface"}
              style={isExpanded ? undefined : { height: `${MIN_START_HEIGHT}px` }}
            />
          </Show>
        }
      >
        <iframe
          ref={setFinalEl}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          title="Interactive widget"
          src={finalUrl()}
          onLoad={() => {
            aiController.abort();
            frameMountedAt = Date.now();
            lastFrameInteractionAt = 0;
            hasFrameInteracted = false;
            syncFrameAppearance();
          }}
          onPointerEnter={() => {
            lastFrameInteractionAt = Date.now();
          }}
          onPointerDown={() => {
            lastFrameInteractionAt = Date.now();
            hasFrameInteracted = true;
          }}
          onFocus={() => {
            const now = Date.now();
            lastFrameInteractionAt = now;
            if (frameMountedAt > 0 && now - frameMountedAt >= MIN_MOUNT_SETTLE_MS) {
              hasFrameInteracted = true;
            }
          }}
          class={
            isExpanded
              ? "block min-h-0 w-full flex-1 border-0 bg-surface"
              : "block w-full border-0 bg-surface transition-[height] duration-200 ease-out motion-reduce:transition-none"
          }
          style={
            isExpanded
              ? undefined
              : { height: `${clampFrameHeight(finalHeight() || MIN_START_HEIGHT)}px` }
          }
        />
      </Show>
      <Show when={error()}>
        <div class="flex shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-subtle px-3 py-2">
          <span class="shrink-0 text-2xs font-medium text-danger">Widget error</span>
          <span class="min-w-0 flex-1 truncate text-2xs text-fg-secondary" data-rc-tip={error()}>
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
            data-rc-tip="Dismiss error"
            class="rc-msg-action inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-inner text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors"
            onClick={() => setError("")}
          >
            <Icon icon="lucide:x" size={12} />
          </button>
        </div>
      </Show>
    </>
  );

  return (
    <>
      {/* One surface only: the host card and the widget document share the
          `--surface` token, so the frame seam is invisible. While the widget is
          not ready, a centered loading pill (placeholder text) floats over
          the streaming preview; runtime errors land in the footer below. */}
      <Show
        when={expanded()}
        fallback={
          <div
            ref={(el) => {
              hostRootEl = el;
            }}
            class="group/guhost mb-3"
          >
            <div class="gu-card-host relative overflow-hidden rounded-panel border border-border bg-surface">
              <Show when={!streaming()}>
                <Show
                  when={!dockInlineToolbar()}
                  fallback={
                    <div class="flex items-center justify-end gap-0.5 border-b border-border-subtle bg-surface-subtle/60 px-2 py-1">
                      <div class="flex items-center gap-0.5">{renderToolbarButtons()}</div>
                    </div>
                  }
                >
                  <div class="gu-host-toolbar pointer-events-none absolute top-2 right-2 z-20 flex items-center gap-0.5 rounded-inner border border-border/80 bg-surface-raised/90 p-0.5 shadow-resting backdrop-blur-sm">
                    <div class="pointer-events-auto flex items-center gap-0.5">
                      {renderToolbarButtons()}
                    </div>
                  </div>
                </Show>
              </Show>
              {renderCardContents(false)}
            </div>
          </div>
        }
      >
        <div
          class="mb-3 rounded-panel border border-border-subtle bg-surface-subtle"
          style={{ height: `${clampFrameHeight(finalHeight() || MIN_START_HEIGHT)}px` }}
          aria-hidden="true"
        />
        <Portal>
          <div
            ref={(el) => {
              hostRootEl = el;
            }}
            data-density="compact"
            class="group/guhost fixed inset-0 z-[var(--z-modal)] flex flex-col overflow-hidden bg-background/95 pt-[var(--sat)] pb-[var(--sab)] pl-[var(--sal)] pr-[var(--sar)]"
          >
            <Show when={!streaming()}>
              <div class="flex shrink-0 items-center justify-end gap-1 border-b border-border-subtle bg-surface px-2.5 py-1.5">
                <div class="flex items-center gap-0.5">{renderToolbarButtons()}</div>
              </div>
            </Show>
            <div class="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
              {renderCardContents(true)}
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

const frameHeights = new Map<string, number>();

export { parseGenerativeUiDsl };
export type { GenerativeUiData };
