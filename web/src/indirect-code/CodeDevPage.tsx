import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
  batch,
} from "solid-js";
import { createHosts } from "./hooks/useHosts";
import { createRelay } from "./hooks/useRelay";
import { createMirror } from "./hooks/useMirror";
import { RemoteHints } from "./presentation";
import { Icon, Icons, toast } from "../ui";

interface DebugTool {
  name: string;
  description: string;
  schema: any;
  allowedModes?: string[];
  isAuto?: boolean;
  deferred?: boolean;
}

interface CapturedRequest {
  id: string;
  turnIndex: number;
  step: number;
  endpoint: string;
  model: string;
  system: string;
  reasoning: string;
  maxTokens: number;
  sessionId: string;
  tools: any[];
  messages: any[];
  rawPayload: any;
  timestamp: number;
  usage?: any;
  stopReason?: string;
  isSimulated?: boolean;
}

interface LiveEvent {
  id: string;
  type: string;
  sessionId: string;
  turnIndex?: number;
  step?: number;
  timestamp: number;
  data: any;
}

interface RawFrame {
  id: string;
  timestamp: number;
  type: string;
  direction?: "in" | "out";
  sessionId?: string;
  size: number;
  payload: any;
}

interface WalEventItem {
  seq: number;
  type: string;
  timestamp?: number;
  payload: any;
}

/**
 * Tokenize and format a single line of JSON with Chrome DevTools-style syntax highlighting.
 */
function highlightJsonLine(line: string, searchMatch?: string): string {
  let escaped = line
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  escaped = escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          const colonIdx = match.lastIndexOf(":");
          const keyPart = match.slice(0, colonIdx);
          const colonPart = match.slice(colonIdx);
          return `<span class="text-tone-sky font-medium">${keyPart}</span><span class="text-fg-secondary">${colonPart}</span>`;
        }
        return `<span class="text-success">${match}</span>`;
      }
      if (/true|false/.test(match)) {
        return `<span class="text-warning font-medium">${match}</span>`;
      }
      if (/null/.test(match)) {
        return `<span class="text-danger italic font-medium">${match}</span>`;
      }
      return `<span class="text-tone-violet font-mono">${match}</span>`;
    },
  );

  if (searchMatch && searchMatch.trim()) {
    const escapedQuery = searchMatch
      .trim()
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const q = escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (q) {
      const re = new RegExp(`(${q})`, "gi");
      escaped = escaped
        .split(/(<[^>]+>)/g)
        .map((part) => {
          if (part.startsWith("<") && part.endsWith(">")) {
            return part;
          }
          return part.replace(
            re,
            `<mark class="bg-warning-subtle text-warning rounded px-0.5 font-medium">$1</mark>`,
          );
        })
        .join("");
    }
  }

  return escaped;
}

/**
 * Chrome DevTools-inspired JSON Viewer with line numbers, syntax highlighting, search, and copy.
 */
function JsonHighlightViewer(props: {
  data: any;
  title?: string;
  maxHeight?: string;
  class?: string;
}) {
  const [search, setSearch] = createSignal("");
  const [isCompact, setIsCompact] = createSignal(false);

  const formattedStr = createMemo(() => {
    try {
      if (props.data === undefined) {
        return "";
      }
      if (typeof props.data === "string") {
        return (
          (isCompact()
            ? JSON.stringify(JSON.parse(props.data))
            : JSON.stringify(JSON.parse(props.data), null, 2)) ?? ""
        );
      }
      const val = props.data ?? null;
      return (
        (isCompact()
          ? JSON.stringify(val)
          : JSON.stringify(val, null, 2)) ?? ""
      );
    } catch {
      return String(props.data ?? "");
    }
  });

  const lines = createMemo(() => {
    const str = formattedStr();
    return str ? str.split("\n") : [];
  });

  function copyJson() {
    navigator.clipboard
      .writeText(formattedStr())
      .then(() => toast("JSON copied to clipboard", "ok"))
      .catch(() => toast("Failed to copy JSON to clipboard", "err"));
  }

  function downloadJson() {
    const blob = new Blob([formattedStr() || "{}"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payload_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast("Downloaded JSON", "ok");
  }

  return (
    <div class={`flex flex-col border border-border rounded-panel bg-surface overflow-hidden font-mono text-xs ${props.class || ""}`}>
      {/* Viewer toolbar */}
      <div class="px-3 py-1.5 bg-surface-subtle border-b border-border-subtle flex flex-wrap items-center justify-between shrink-0 gap-2 text-2xs">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <Show when={props.title}>
            <span class="font-medium text-fg text-xs">
              {props.title}
            </span>
          </Show>
          <span class="text-fg-muted text-2xs tabular-nums">
            {lines().length} lines · {new Blob([formattedStr()]).size} bytes
          </span>
        </div>

        <div class="flex flex-wrap items-center gap-1.5">
          {/* Quick search input */}
          <div class="relative flex items-center">
            <input
              type="text"
              placeholder="Find in JSON…"
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              class="bg-background border border-border rounded-md px-2 py-0.5 pr-5 max-sm:text-base sm:text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent w-32 sm:w-36"
            />
            <Show when={search()}>
              <button
                type="button"
                aria-label="Clear search"
                data-rc-tip="Clear search"
                onClick={() => setSearch("")}
                class="absolute right-1 text-fg-muted hover:text-fg text-xs cursor-pointer"
              >
                ×
              </button>
            </Show>
          </div>

          {/* Pretty / Compact toggle */}
          <button
            type="button"
            onClick={() => setIsCompact(!isCompact())}
            class="ui-button ui-button-outline ui-button-xs rounded-md"
            data-rc-tip="Toggle compact or pretty JSON"
          >
            {isCompact() ? "Pretty" : "Compact"}
          </button>

          {/* Copy Button */}
          <button
            type="button"
            onClick={copyJson}
            class="ui-button ui-button-outline ui-button-xs rounded-md gap-1 text-accent"
            data-rc-tip="Copy full JSON"
          >
            <Icon name={Icons.copy} size={11} />
            Copy
          </button>

          {/* Download Button */}
          <button
            type="button"
            onClick={downloadJson}
            class="ui-button ui-button-outline ui-button-xs rounded-md gap-1"
            data-rc-tip="Download JSON file"
          >
            <Icon name={Icons.save} size={11} />
            Download
          </button>
        </div>
      </div>

      {/* Code body with line numbers */}
      <div
        class="overflow-auto bg-background/60 p-2 text-xs leading-relaxed select-text"
        style={{ "max-height": props.maxHeight || "none" }}
      >
        <table class="border-collapse w-full">
          <tbody>
            <For each={lines()}>
              {(line, idx) => (
                <tr class="hover:bg-surface-subtle/80 transition-colors">
                  <td class="select-none text-right pr-3 text-fg-muted font-mono text-2xs w-12 align-top tabular-nums border-r border-border-subtle">
                    {idx() + 1}
                  </td>
                  <td
                    class="pl-3 whitespace-pre font-mono text-fg align-top"
                    // eslint-disable-next-line solid/no-innerhtml
                    innerHTML={highlightJsonLine(line, search())}
                  />
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function CodeDevPage() {
  const [activeTab, setActiveTab] = createSignal<
    "payloads" | "stream" | "system" | "tools" | "frames" | "wal"
  >("payloads");
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>("");
  const [selectedPayloadId, setSelectedPayloadId] = createSignal<string>("");
  const [payloadSubTab, setPayloadSubTab] = createSignal<
    "raw" | "system" | "messages" | "tools" | "headers"
  >("raw");

  // State managed purely in frontend (like Chrome DevTools Network Tab)
  const [capturedPayloads, setCapturedPayloads] = createSignal<CapturedRequest[]>([]);
  const [liveEvents, setLiveEvents] = createSignal<LiveEvent[]>([]);
  const [rawFrames, setRawFrames] = createSignal<RawFrame[]>([]);
  const [preserveLog, setPreserveLog] = createSignal<boolean>(true);

  // WAL State
  const [walEvents, setWalEvents] = createSignal<WalEventItem[]>([]);
  const [selectedWalSeq, setSelectedWalSeq] = createSignal<number | null>(null);
  const [walFilter, setWalFilter] = createSignal<string>("");

  // Debug session data loaded from daemon
  const [systemPrompt, setSystemPrompt] = createSignal<string>("");
  const [nativeTools, setNativeTools] = createSignal<DebugTool[]>([]);
  const [sessionMeta, setSessionMeta] = createSignal<any>(null);

  // Filters & controls
  const [requestFilter, setRequestFilter] = createSignal<string>("");
  const [eventFilter, setEventFilter] = createSignal<string>("all");
  const [toolSearch, setToolSearch] = createSignal<string>("");
  const [autoScroll, setAutoScroll] = createSignal<boolean>(true);
  const [promptInput, setPromptInput] = createSignal<string>("");
  const [expandedEvents, setExpandedEvents] = createSignal<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = createSignal<Record<string, boolean>>({});
  const [liveThinking, setLiveThinking] = createSignal<string>("");
  const [liveText, setLiveText] = createSignal<string>("");
  const [isSimulating, setIsSimulating] = createSignal<boolean>(false);

  let streamContainerRef: HTMLDivElement | undefined;
  let smokeTimeout: ReturnType<typeof setTimeout> | undefined;

  // Initialize Hosts
  const hosts = createHosts({
    toast: (msg, kind) => toast(msg, kind),
    showConfirm: async (opts) => confirm(opts.message || "Confirm?"),
  });

  // Relay connection
  const rawRelay = createRelay({
    getHostId: () => hosts.activeHostId(),
    onMessage: (data: unknown) => {
      const msg = data as any;
      if (!msg) return;

      const now = Date.now();
      const rawStr = JSON.stringify(msg);

      // Record incoming raw frame (frontend-only, up to 300)
      setRawFrames((prev) => [
        {
          id: `frame_${now}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: now,
          type: msg.type || "unknown",
          direction: "in",
          sessionId: msg.sessionId || msg.session?.id,
          size: rawStr.length,
          payload: msg,
        },
        ...prev.slice(0, 300),
      ]);

      // Forward daemon events to SignalDB data layer
      mirror.dataLayer.handleMessage(msg);

      // Handle session debug data
      if (msg.type === "session_debug_data") {
        if (msg.systemPrompt) setSystemPrompt(msg.systemPrompt);
        if (msg.tools && Array.isArray(msg.tools)) setNativeTools(msg.tools);
        if (msg.session) setSessionMeta(msg.session);
        if (msg.walEvents && Array.isArray(msg.walEvents)) setWalEvents(msg.walEvents);
        if (msg.recentPayloads && Array.isArray(msg.recentPayloads) && msg.recentPayloads.length > 0) {
          const items: CapturedRequest[] = msg.recentPayloads.map((p: any, idx: number) => ({
            id: `recent_${p.sessionId || msg.sessionId || selectedSessionId()}_${p.turnIndex ?? 0}_${p.step ?? 0}_${p.timestamp || now}_${idx}`,
            turnIndex: p.turnIndex ?? 0,
            step: p.step ?? 0,
            endpoint: p.endpoint || "/messages",
            model: p.model || "",
            system: p.system || "",
            reasoning: p.reasoning || "",
            maxTokens: p.maxTokens || 0,
            sessionId: p.sessionId || msg.sessionId || selectedSessionId(),
            tools: p.tools || [],
            messages: p.messages || [],
            rawPayload: p.rawPayload,
            timestamp: p.timestamp || now,
            isSimulated: false,
          }));
          items.reverse();
          setCapturedPayloads((prev) => {
            const existingKeys = new Set(prev.map((x) => `${x.sessionId}_${x.turnIndex}_${x.step}_${x.timestamp}`));
            const fresh = items.filter((x) => !existingKeys.has(`${x.sessionId}_${x.turnIndex}_${x.step}_${x.timestamp}`));
            return [...fresh, ...prev];
          });
          setSelectedPayloadId((current) => current || (items[0] ? items[0].id : ""));
        }
      }

      // Handle Smoke Simulation Result
      if (msg.type === "preview_prompt_result") {
        if (smokeTimeout) {
          clearTimeout(smokeTimeout);
          smokeTimeout = undefined;
        }
        setIsSimulating(false);
        const p = msg.payload;
        if (p) {
          const item: CapturedRequest = {
            id: `smoke_${now}_${Math.random().toString(36).slice(2, 6)}`,
            turnIndex: p.turnIndex ?? 1,
            step: p.step ?? 0,
            endpoint: p.endpoint || "/messages",
            model: p.model || "simulated",
            system: p.system || "",
            reasoning: p.reasoning || "",
            maxTokens: p.maxTokens || 0,
            sessionId: msg.sessionId || selectedSessionId(),
            tools: p.tools || [],
            messages: p.messages || [],
            rawPayload: p.rawPayload,
            timestamp: now,
            isSimulated: true,
          };
          setCapturedPayloads((prev) => [item, ...prev]);
          setSelectedPayloadId(item.id);
          toast("Smoke simulation payload captured (0 tokens billed)", "ok");
        } else if (msg.error) {
          toast(`Simulation error: ${msg.error}`, "err");
        }
      }

      if (msg.type === "error" && isSimulating()) {
        if (smokeTimeout) {
          clearTimeout(smokeTimeout);
          smokeTimeout = undefined;
        }
        setIsSimulating(false);
        toast(`Simulation error: ${msg.message || msg.error || "Request failed"}`, "err");
      }

      // Handle live agent_events
      if (msg.type === "agent_event" && msg.event) {
        const ev = msg.event;
        const sid = msg.sessionId || "";

        // Record live events (frontend-only)
        setLiveEvents((prev) => [
          {
            id: `ev_${now}_${Math.random().toString(36).slice(2, 7)}`,
            type: ev.type,
            sessionId: sid,
            turnIndex: ev.turnIndex,
            step: ev.step,
            timestamp: now,
            data: ev,
          },
          ...prev.slice(0, 500),
        ]);

        if (autoScroll() && streamContainerRef) {
          setTimeout(() => {
            if (streamContainerRef) streamContainerRef.scrollTop = 0;
          }, 20);
        }

        // Live streaming deltas
        if (ev.type === "reasoning_delta") {
          setLiveThinking((prev) => prev + (ev.delta || ""));
        } else if (ev.type === "text_delta") {
          setLiveText((prev) => prev + (ev.delta || ""));
        } else if (ev.type === "turn_start" || ev.type === "assistant_start") {
          if (ev.type === "turn_start") {
            setLiveThinking("");
            setLiveText("");
          }
        } else if (ev.type === "turn_end") {
          setCapturedPayloads((prev) => {
            if (prev.length === 0) return prev;
            const updated = [...prev];
            updated[0] = {
              ...updated[0],
              stopReason: ev.stop,
              usage: ev.usage,
            };
            return updated;
          });
        }

        // Captured real LLM request right when sent to AI
        if (ev.type === "debug_llm_request") {
          const reqItem: CapturedRequest = {
            id: `payload_${ev.turnIndex || 0}_${ev.step || 0}_${now}`,
            turnIndex: ev.turnIndex ?? 0,
            step: ev.step ?? 0,
            endpoint: ev.endpoint || "",
            model: ev.model || "",
            system: ev.system || "",
            reasoning: ev.reasoning || "",
            maxTokens: ev.maxTokens || 0,
            sessionId: sid,
            tools: ev.tools || [],
            messages: ev.messages || [],
            rawPayload: ev.rawPayload,
            timestamp: ev.timestamp || now,
            isSimulated: false,
          };

          batch(() => {
            setCapturedPayloads((prev) => [reqItem, ...prev]);
            setSelectedPayloadId(reqItem.id);
            if (ev.system) setSystemPrompt(ev.system);
            if (ev.tools && Array.isArray(ev.tools) && ev.tools.length > 0) {
              setNativeTools((prev) => {
                if (prev.length === 0) return ev.tools;
                return prev;
              });
            }
          });
        }
      }
    },
    onOpen: (hostId) => {
      mirror.dataLayer.storeFor(hostId).syncAll().catch(() => {});
      requestSessionDebug();
    },
    onClose: () => {},
    ensureAuth: () => hosts.loadHosts(),
    isActiveHost: (hostId) => hosts.activeHostId() === hostId,
  });

  const recordOutgoingFrame = (payload: any) => {
    const now = Date.now();
    const rawStr = JSON.stringify(payload ?? {});
    setRawFrames((prev) => [
      {
        id: `frame_out_${now}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: now,
        type: payload?.type || "unknown",
        direction: "out",
        sessionId: payload?.sessionId || payload?.session?.id,
        size: rawStr.length,
        payload,
      },
      ...prev.slice(0, 300),
    ]);
  };

  const relay = {
    ...rawRelay,
    send: (payload: any) => {
      recordOutgoingFrame(payload);
      return rawRelay.send(payload);
    },
  };

  const mirror = createMirror({
    send: (payload) => relay.send(payload),
    isOpen: () => relay.wsOpen(),
    getHostId: () => hosts.activeHostId(),
  });

  const sessions = () => mirror.sessions();

  function requestSessionDebug() {
    const hid = hosts.activeHostId();
    if (!hid) return;
    relay.send({
      type: "get_session_debug" as any,
      sessionId: selectedSessionId(),
      hostId: hid,
      requestId: `dbg_${Date.now()}`,
    } as any);
  }

  onMount(async () => {
    (window as any).__devTest = {
      relay,
      setRawFrames,
      setWalEvents,
      rawFrames,
      walEvents,
      recordOutgoingFrame,
    };
    await hosts.loadHosts();
    const hid = hosts.activeHostId();
    if (hid) {
      relay.connect(hid);
    }
  });

  onCleanup(() => {
    if (smokeTimeout) {
      clearTimeout(smokeTimeout);
      smokeTimeout = undefined;
    }
  });

  createEffect(() => {
    const hid = hosts.activeHostId();
    if (hid) {
      relay.connect(hid);
      requestSessionDebug();
    }
  });

  // When session selection changes
  createEffect(() => {
    void selectedSessionId();
    if (!preserveLog()) {
      clearAllNetworkLogs();
    }
    requestSessionDebug();
  });

  // Auto-select session if none selected
  createEffect(() => {
    const list = sessions();
    if (list.length > 0 && !selectedSessionId()) {
      const running = list.find((s) => s.status === "running");
      setSelectedSessionId((running ?? list[0]).id);
    }
  });

  const filteredCapturedPayloads = createMemo(() => {
    const q = requestFilter().trim().toLowerCase();
    const list = capturedPayloads();
    if (!q) return list;
    return list.filter(
      (p) =>
        p.model.toLowerCase().includes(q) ||
        p.endpoint.toLowerCase().includes(q) ||
        String(p.turnIndex).includes(q) ||
        (p.isSimulated && (q.includes("smoke") || (q.length >= 3 && "smoke".startsWith(q)))),
    );
  });

  const selectedPayload = createMemo(() => {
    const id = selectedPayloadId();
    const list = capturedPayloads();
    if (!id && list.length > 0) return list[0];
    return list.find((p) => p.id === id) ?? list[0] ?? null;
  });

  const activeSession = createMemo(() => {
    const sid = selectedSessionId();
    return sessions().find((s) => s.id === sid) ?? null;
  });

  const derivedWalEvents = createMemo<WalEventItem[]>(() => {
    if (walEvents().length > 0) return walEvents();

    const s = activeSession();
    const meta = sessionMeta();
    if (!s && !meta) return [];

    const items: WalEventItem[] = [];
    let seq = 1;

    items.push({
      seq: seq++,
      type: "header",
      timestamp: s?.createdAt || Date.now(),
      payload: {
        turnIndex: meta?.turnSeq || 1,
        startedAt: s?.createdAt || Date.now(),
        model: meta?.model || s?.model || "default",
        executionScope: meta?.cwd || s?.cwd || "/",
      },
    });

    if (meta?.mode || s?.options) {
      items.push({
        seq: seq++,
        type: "options",
        timestamp: s?.createdAt || Date.now(),
        payload: {
          mode: meta?.mode || s?.options?.mode || "agentic",
          effort: meta?.effort || s?.options?.effort || "high",
          access: meta?.access || s?.options?.access || "full",
        },
      });
    }

    if (meta?.title || s?.title) {
      items.push({
        seq: seq++,
        type: "title",
        timestamp: s?.createdAt || Date.now(),
        payload: {
          title: meta?.title || s?.title,
          titleSource: "session",
        },
      });
    }

    const payloads = capturedPayloads();
    for (const p of payloads) {
      items.push({
        seq: seq++,
        type: "msg",
        timestamp: p.timestamp,
        payload: {
          turnIndex: p.turnIndex,
          step: p.step,
          model: p.model,
          endpoint: p.endpoint,
          messages: p.messages,
          tools: p.tools,
          isSimulated: p.isSimulated,
        },
      });
      if (p.usage) {
        items.push({
          seq: seq++,
          type: "usage",
          timestamp: p.timestamp,
          payload: p.usage,
        });
      }
    }

    items.push({
      seq: seq,
      type: "meta",
      timestamp: s?.updatedAt || Date.now(),
      payload: {
        status: meta?.status || s?.status || "idle",
        pinned: meta?.pinned ?? s?.pinned ?? false,
        updatedAt: s?.updatedAt || Date.now(),
      },
    });

    return items;
  });

  const filteredWalEvents = createMemo(() => {
    const filter = walFilter().toLowerCase().trim();
    const list = derivedWalEvents();
    if (!filter) return list;
    return list.filter(
      (ev) =>
        ev.type.toLowerCase().includes(filter) ||
        JSON.stringify(ev.payload || {}).toLowerCase().includes(filter),
    );
  });

  const selectedWalEvent = createMemo(() => {
    const seq = selectedWalSeq();
    const list = filteredWalEvents();
    if (seq === null && list.length > 0) return list[0];
    return list.find((e) => e.seq === seq) ?? list[0] ?? null;
  });

  /**
   * Chrome DevTools Network Tab Clear Button:
   * Wipes the frontend-captured requests, live events, and frames!
   */
  function clearAllNetworkLogs() {
    setCapturedPayloads([]);
    setSelectedPayloadId("");
    setLiveEvents([]);
    setRawFrames([]);
    setWalEvents([]);
    setSelectedWalSeq(null);
    setLiveThinking("");
    setLiveText("");
  }

  /**
   * Quick Prompt: dispatches real turn prompt to the session.
   */
  function sendQuickPrompt() {
    const text = promptInput().trim();
    const sid = selectedSessionId();
    const hid = hosts.activeHostId();
    if (!text || !sid || !hid) return;

    const currentSession = sessions().find((s) => s.id === sid);
    // The daemon REPLACES the session options from every prompt, so the
    // quick prompt must echo the session's own values: an invented
    // "default" effort would be canonicalized to "" and persisted. Missing
    // values stay missing (the daemon normalizes an absent effort to its
    // default), never a placeholder.
    const mode = sessionMeta()?.mode || currentSession?.options?.mode || "agentic";
    const effort = sessionMeta()?.effort || currentSession?.options?.effort || "";
    const access = sessionMeta()?.access || currentSession?.options?.access || "full";
    // options.skills is a create/configure input the daemon echoes empty;
    // the live selection is the session skill map and is not touched by a
    // prompt, so sending [] here is a no-op by contract.
    const skills: { name: string; usable?: string }[] = [];

    relay.send({
      type: "prompt",
      sessionId: sid,
      text,
      hostId: hid,
      model: "",
      yolo: true,
      options: { mode, effort, access, skills },
      attachmentIds: [],
      requestId: `prompt_${Date.now()}`,
    } as any);
    setPromptInput("");
  }

  /**
   * Smoke Simulation Mode:
   * Requests daemon to simulate the exact payload that WOULD be sent to the AI,
   * without calling the LLM or billing any tokens!
   */
  function runSmokeSimulation() {
    const sid = selectedSessionId();
    const hid = hosts.activeHostId();
    if (!hid) return;

    if (smokeTimeout) {
      clearTimeout(smokeTimeout);
      smokeTimeout = undefined;
    }

    try {
      if (!relay.wsOpen()) {
        toast("Relay not connected", "err");
        setIsSimulating(false);
        return;
      }

      setIsSimulating(true);

      smokeTimeout = setTimeout(() => {
        setIsSimulating(false);
        toast("Smoke simulation timed out", "err");
      }, 10000);

      relay.send({
        type: "preview_prompt" as any,
        sessionId: sid,
        text: promptInput().trim(),
        hostId: hid,
        requestId: `smoke_${Date.now()}`,
      } as any);
    } catch (err) {
      if (smokeTimeout) {
        clearTimeout(smokeTimeout);
        smokeTimeout = undefined;
      }
      setIsSimulating(false);
      toast(`Failed to run smoke simulation: ${err instanceof Error ? err.message : String(err)}`, "err");
    }
  }

  function copyText(val: string, label = "Copied") {
    navigator.clipboard
      .writeText(val)
      .then(() => toast(`${label} to clipboard`, "ok"))
      .catch(() => toast("Failed to copy", "err"));
  }

  const filteredEvents = createMemo(() => {
    const filter = eventFilter();
    const list = liveEvents();
    if (filter === "all") return list;
    if (filter === "llm") return list.filter((e) => e.type.startsWith("debug_llm"));
    if (filter === "tool") return list.filter((e) => e.type.startsWith("tool"));
    if (filter === "text") return list.filter((e) => e.type.includes("text") || e.type.includes("reasoning"));
    if (filter === "turns") return list.filter((e) => e.type.startsWith("turn_"));
    return list.filter((e) => e.type === filter);
  });

  const filteredTools = createMemo(() => {
    const q = toolSearch().trim().toLowerCase();
    const list = nativeTools();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q)),
    );
  });

  return (
    <div
      data-density="compact"
      class="flex flex-col min-h-dvh lg:h-screen w-full max-w-full bg-background text-fg font-sans select-text overflow-x-hidden lg:overflow-hidden"
    >
      <RemoteHints />
      {/* ===== TOP BAR / HEADER ===== */}
      <header class="flex flex-wrap items-center justify-between px-4 py-2 bg-surface-subtle border-b border-border shrink-0 gap-3 z-20">
        <div class="flex flex-wrap items-center gap-3 min-w-0 max-w-full">
          <div class="flex items-center gap-2 min-w-0">
            <span class="inline-flex items-center justify-center rounded-md bg-accent-subtle px-2 py-0.5 text-accent font-mono font-medium text-2xs border border-accent/35 shrink-0">
              Dev
            </span>
            <div class="flex flex-col min-w-0">
              <span class="font-medium text-sm tracking-tight flex flex-wrap items-center gap-1.5">
                Indirect Code · Network Inspector
                <span class="text-2xs px-1.5 py-0.5 rounded-md bg-success-subtle text-success font-mono font-normal">
                  DevTools
                </span>
              </span>
              <span class="text-2xs text-fg-muted hidden sm:inline">
                Exact AI wire payloads, full system prompt & native tools
              </span>
            </div>
          </div>

          <div class="h-5 w-px bg-border mx-1 hidden md:block" />

          {/* Host Selector */}
          <div class="flex items-center gap-1.5 min-w-0 max-w-full">
            <span class="text-xs text-fg-secondary shrink-0">Host:</span>
            <select
              value={hosts.activeHostId()}
              onChange={(e) => hosts.setActiveHostId(e.currentTarget.value)}
              class="min-w-0 max-w-56 bg-surface border border-border rounded-control px-2 py-1 max-sm:text-base sm:text-xs font-mono text-fg focus:outline-none focus:border-accent truncate"
            >
              <For each={hosts.hosts()}>
                {(h) => (
                  <option value={h.id}>
                    {h.name || h.hostname || h.id} ({h.status})
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Session Selector */}
          <div class="flex items-center gap-1.5 min-w-0 max-w-full sm:max-w-xs">
            <span class="text-xs text-fg-secondary shrink-0">Session:</span>
            <select
              value={selectedSessionId()}
              onChange={(e) => setSelectedSessionId(e.currentTarget.value)}
              class="min-w-0 flex-1 max-w-56 sm:max-w-64 bg-surface border border-border rounded-control px-2 py-1 max-sm:text-base sm:text-xs font-mono text-fg focus:outline-none focus:border-accent truncate"
            >
              <option value="">No session (default)</option>
              <For each={sessions()}>
                {(s) => (
                  <option value={s.id}>
                    {s.status === "running" ? "▶ [Running] " : "[Idle] "}
                    {s.title ? (s.title.length > 25 ? s.title.slice(0, 25) + "…" : s.title) : s.id.slice(0, 8)} ({s.model || "default"})
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Status Badge */}
          <Show when={activeSession()}>
            <span
              class={`text-2xs px-2 py-0.5 rounded-pill font-mono font-medium flex items-center gap-1.5 ${
                activeSession()?.status === "running"
                  ? "bg-success-subtle text-success border border-success/35 animate-pulse"
                  : "bg-surface border border-border text-fg-muted"
              }`}
            >
              <span
                class={`w-1.5 h-1.5 rounded-full ${
                  activeSession()?.status === "running" ? "bg-success" : "bg-fg-muted"
                }`}
              />
              {activeSession()?.status}
            </span>
          </Show>
        </div>

        {/* Action Controls */}
        <div class="flex flex-wrap items-center gap-2">
          {/* Preserve Log Toggle */}
          <label
            class="flex items-center gap-1.5 text-xs text-fg-secondary hover:text-fg cursor-pointer mr-1"
            data-rc-tip="Preserve captured logs across session switches"
            data-rc-tip-placement="bottom"
          >
            <input
              type="checkbox"
              checked={preserveLog()}
              onChange={(e) => setPreserveLog(e.currentTarget.checked)}
              class="rounded bg-surface border-border"
            />
            Preserve log
          </label>

          {/* Chrome-Style Clear Network Log Button */}
          <button
            type="button"
            onClick={clearAllNetworkLogs}
            class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1.5 hover:bg-danger-subtle hover:text-danger"
            data-rc-tip="Clear all recorded network payloads and events (Frontend-only)"
            data-rc-tip-placement="bottom"
          >
            <Icon name="lucide:ban" size={13} class="text-danger" />
            Clear log
          </button>

          {/* WS Connection Indicator */}
          <span
            class={`text-2xs font-mono px-2 py-0.5 rounded-pill flex items-center gap-1.5 ${
              relay.wsOpen()
                ? "bg-success-subtle text-success border border-success/35"
                : "bg-danger-subtle text-danger border border-danger/35"
            }`}
          >
            <span
              class={`w-1.5 h-1.5 rounded-full ${relay.wsOpen() ? "bg-success" : "bg-danger"}`}
            />
            {relay.wsOpen() ? "Relay live" : "Disconnected"}
          </span>

          <button
            type="button"
            onClick={requestSessionDebug}
            class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1.5"
            data-rc-tip="Refresh daemon debug state"
            data-rc-tip-placement="bottom"
          >
            <Icon name={Icons.refresh} size={13} />
            Refresh
          </button>
        </div>
      </header>

      {/* ===== MAIN NAV TABS ===== */}
      <div class="flex items-center px-4 bg-surface-subtle border-b border-border shrink-0 gap-1 text-xs overflow-x-auto whitespace-nowrap">
        <button
          onClick={() => setActiveTab("payloads")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "payloads"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name={Icons.bolt} size={14} />
          Network payloads ({capturedPayloads().length})
        </button>

        <button
          onClick={() => setActiveTab("stream")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "stream"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name={Icons.play} size={14} />
          Live event stream ({liveEvents().length})
          <Show when={activeSession()?.status === "running"}>
            <span class="w-2 h-2 rounded-full bg-success animate-pulse" />
          </Show>
        </button>

        <button
          onClick={() => setActiveTab("system")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "system"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name={Icons.file} size={14} />
          System prompt
        </button>

        <button
          onClick={() => setActiveTab("tools")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "tools"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name={Icons.terminal} size={14} />
          Native tools ({nativeTools().length})
        </button>

        <button
          onClick={() => setActiveTab("wal")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "wal"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name="lucide:database" size={14} />
          WAL state ({derivedWalEvents().length})
        </button>

        <button
          onClick={() => setActiveTab("frames")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "frames"
              ? "border-accent text-fg"
              : "border-transparent text-fg-muted hover:text-fg"
          }`}
        >
          <Icon name={Icons.layers} size={14} />
          WS frames ({rawFrames().length})
        </button>
      </div>

      {/* ===== BODY CONTENT PANES ===== */}
      <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* 1. LLM PAYLOADS TAB (Chrome DevTools Network Style) */}
        <Show when={activeTab() === "payloads"}>
          <div class="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
            {/* Left Pane: Requests Network Table / List */}
            <div class="w-full max-h-56 lg:max-h-none lg:w-88 border-b lg:border-b-0 lg:border-r border-border bg-surface-subtle flex flex-col shrink-0">
              {/* Table search & counter */}
              <div class="p-2 border-b border-border-subtle flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Filter requests…"
                  value={requestFilter()}
                  onInput={(e) => setRequestFilter(e.currentTarget.value)}
                  class="min-w-0 flex-1 bg-surface border border-border rounded-control px-2.5 py-1 max-sm:text-base sm:text-xs font-mono text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent"
                />
                <button
                  type="button"
                  onClick={clearAllNetworkLogs}
                  class="ui-icon-button ui-icon-button-xs rounded-lg hover:bg-danger-subtle hover:text-danger"
                  aria-label="Clear requests log"
                  data-rc-tip="Clear requests log"
                >
                  <Icon name={Icons.trash} size={14} />
                </button>
              </div>

              {/* Request rows */}
              <div class="flex-1 overflow-y-auto divide-y divide-border-subtle font-mono text-xs">
                <Show
                  when={filteredCapturedPayloads().length > 0}
                  fallback={
                    <div class="p-8 text-center text-xs text-fg-muted flex flex-col items-center gap-2 font-sans">
                      <span class="font-medium text-fg-secondary">No requests captured yet</span>
                      <span class="text-2xs text-fg-muted">
                        Recordings stay in your browser until cleared. Dispatch a real prompt or run Smoke test below.
                      </span>
                    </div>
                  }
                >
                  <For each={filteredCapturedPayloads()}>
                    {(req) => (
                      <button
                        onClick={() => setSelectedPayloadId(req.id)}
                        class={`w-full text-left p-2.5 transition-colors cursor-pointer flex flex-col gap-1 border-l-2 ${
                          selectedPayload()?.id === req.id
                            ? req.isSimulated
                              ? "bg-warning-subtle border-warning text-fg"
                              : "bg-accent-subtle border-accent text-fg"
                            : req.isSimulated
                              ? "border-warning/35 hover:bg-surface-muted/70 text-fg-secondary"
                              : "border-transparent hover:bg-surface-muted/70 text-fg-secondary"
                        }`}
                      >
                        <div class="flex items-center justify-between text-xs">
                          <div class="flex items-center gap-1.5">
                            <span
                              class={`w-2 h-2 rounded-full ${
                                req.isSimulated
                                  ? "bg-warning"
                                  : req.stopReason === "error"
                                    ? "bg-danger"
                                    : "bg-success"
                              }`}
                            />
                            <span class="font-medium text-fg">
                              POST /messages
                            </span>
                          </div>
                          <span class="text-2xs text-fg-muted tabular-nums">
                            {new Date(req.timestamp).toLocaleTimeString()}
                          </span>
                        </div>

                        <div class="flex items-center justify-between text-xs gap-2">
                          <span class="truncate text-fg-secondary">
                            {req.model || "default"}
                          </span>
                          <Show when={req.isSimulated}>
                            <span class="text-2xs px-1.5 py-0.5 rounded-md bg-warning-subtle text-warning font-medium border border-warning/35 flex items-center gap-1 shrink-0">
                              <Icon name="lucide:flame" size={10} /> Smoke
                            </span>
                          </Show>
                        </div>

                        <div class="flex items-center gap-1.5 text-2xs text-fg-muted mt-0.5 tabular-nums">
                          <span>T#{req.turnIndex} S#{req.step}</span>
                          <span>·</span>
                          <span>{req.tools?.length || 0} tools</span>
                          <span>·</span>
                          <span>{req.messages?.length || 0} msgs</span>
                          <Show when={req.usage?.outputTokens}>
                            <span>·</span>
                            <span class="text-success font-medium">
                              {req.usage.outputTokens} tok
                            </span>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </div>

            {/* Right Pane: Inspector / Chrome DevTools Network Style */}
            <div class="flex-1 min-h-[26rem] lg:min-h-0 flex flex-col bg-background overflow-hidden">
              <Show
                when={selectedPayload()}
                fallback={
                  <div class="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-fg-muted gap-2">
                    <Icon name={Icons.bolt} size={24} class="text-fg-muted" />
                    <span>Select a captured request or run a smoke simulation below.</span>
                  </div>
                }
              >
                {(req) => (
                  <div class="flex-1 flex flex-col min-h-0">
                    {/* Header banner info */}
                    <div class="px-4 py-2 bg-surface-subtle border-b border-border flex flex-wrap items-center justify-between gap-2 shrink-0 font-mono text-xs">
                      <div class="flex flex-wrap items-center gap-3 min-w-0">
                        <Show when={req().isSimulated}>
                          <span class="px-2 py-0.5 rounded-md bg-warning-subtle text-warning font-medium border border-warning/35 text-2xs flex items-center gap-1">
                            <Icon name="lucide:flame" size={12} /> Smoke simulation (0 tokens)
                          </span>
                        </Show>
                        <span class="font-medium text-accent break-all">
                          {req().endpoint || "POST /messages"}
                        </span>
                        <span class="text-fg-secondary">
                          Model: <span class="font-medium text-fg">{req().model}</span>
                        </span>
                        <Show when={req().reasoning}>
                          <span class="text-fg-secondary">
                            Effort: <span class="font-medium text-warning">{req().reasoning}</span>
                          </span>
                        </Show>
                        <span class="text-fg-secondary">
                          Max tokens: <span class="font-medium text-fg tabular-nums">{req().maxTokens}</span>
                        </span>
                      </div>

                      <div class="flex items-center gap-2">
                        <span class="text-fg-muted text-2xs tabular-nums">
                          {new Date(req().timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>

                    {/* Inspector Sub-Tabs (Chrome Network style) */}
                    <div class="flex items-center px-4 bg-surface border-b border-border shrink-0 gap-1 text-xs overflow-x-auto whitespace-nowrap">
                      <button
                        onClick={() => setPayloadSubTab("raw")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "raw"
                            ? "border-accent text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        Wire payload
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("system")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "system"
                            ? "border-accent text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        System prompt
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("messages")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "messages"
                            ? "border-accent text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        Messages ({req().messages?.length || 0})
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("tools")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "tools"
                            ? "border-accent text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        Tools ({req().tools?.length || 0})
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("headers")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "headers"
                            ? "border-accent text-fg"
                            : "border-transparent text-fg-muted hover:text-fg"
                        }`}
                      >
                        Headers & summary
                      </button>
                    </div>

                    {/* Sub-tab view body */}
                    <div class="flex-1 min-h-0 overflow-auto p-4 font-mono text-xs">
                      {/* Sub-tab 1: Raw Wire Payload JSON */}
                      <Show when={payloadSubTab() === "raw"}>
                        <JsonHighlightViewer
                          data={req().rawPayload}
                          title="Exact HTTP POST request body"
                          class="h-full"
                        />
                      </Show>

                      {/* Sub-tab 2: System Prompt */}
                      <Show when={payloadSubTab() === "system"}>
                        <div class="flex flex-col gap-3 h-full">
                          <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-secondary bg-surface p-2.5 rounded-panel border border-border">
                            <div class="flex flex-wrap items-center gap-3 tabular-nums">
                              <span>Chars: <span class="font-medium text-fg">{req().system?.length || 0}</span></span>
                              <span>·</span>
                              <span>Words: <span class="font-medium text-fg">{req().system?.split(/\s+/).length || 0}</span></span>
                              <span>·</span>
                              <span>Est. tokens: <span class="font-medium text-warning">~{Math.round((req().system?.length || 0) / 4)}</span></span>
                            </div>
                            <button
                              onClick={() => copyText(req().system, "System prompt")}
                              class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1.5"
                            >
                              <Icon name={Icons.copy} size={12} />
                              Copy prompt
                            </button>
                          </div>
                          <pre class="bg-surface p-4 rounded-panel border border-border text-fg overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed flex-1 select-text">
                            {req().system || "(No system prompt in this request)"}
                          </pre>
                        </div>
                      </Show>

                      {/* Sub-tab 3: Messages Array */}
                      <Show when={payloadSubTab() === "messages"}>
                        <div class="flex flex-col gap-3">
                          <For each={req().messages}>
                            {(m: any, idx) => (
                              <div class="border border-border rounded-panel bg-surface overflow-hidden">
                                <div class="px-3 py-1.5 bg-surface-subtle border-b border-border-subtle flex items-center justify-between text-xs">
                                  <span class="font-medium flex items-center gap-2">
                                    <span class="text-fg-muted font-mono tabular-nums">#{idx()}</span>
                                    <span
                                      class={`px-2 py-0.5 rounded-md text-2xs font-mono font-medium ${
                                        m.role === "user"
                                          ? "bg-info-subtle text-tone-sky border border-tone-sky/30"
                                          : m.role === "assistant"
                                            ? "bg-accent-subtle text-tone-violet border border-tone-violet/30"
                                            : "bg-warning-subtle text-warning border border-warning/35"
                                      }`}
                                    >
                                      {m.role}
                                    </span>
                                  </span>
                                  <span class="text-fg-muted text-2xs">
                                    {Array.isArray(m.content) ? `${m.content.length} blocks` : "raw text"}
                                  </span>
                                </div>
                                <div class="p-3 text-xs overflow-x-auto">
                                  <Show
                                    when={Array.isArray(m.content)}
                                    fallback={
                                      <pre class="whitespace-pre-wrap text-fg">{String(m.content)}</pre>
                                    }
                                  >
                                    <div class="flex flex-col gap-2">
                                      <For each={m.content}>
                                        {(block: any) => (
                                          <div class="bg-background/60 p-3 rounded-lg border border-border-subtle">
                                            <div class="text-2xs text-fg-secondary mb-1 font-medium">
                                              Block: {block.type || (block.Text ? "text" : "data")}
                                            </div>
                                            <Show
                                              when={block.type === "text" || block.Text}
                                              fallback={<JsonHighlightViewer data={block} maxHeight="200px" />}
                                            >
                                              <pre class="whitespace-pre-wrap text-fg text-xs leading-relaxed">
                                                {block.text || block.Text}
                                              </pre>
                                            </Show>
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      {/* Sub-tab 4: Tools in Request */}
                      <Show when={payloadSubTab() === "tools"}>
                        <div class="flex flex-col gap-3">
                          <For each={req().tools}>
                            {(t: any) => (
                              <div class="border border-border rounded-panel bg-surface p-3">
                                <div class="flex items-center justify-between mb-1.5 gap-2">
                                  <span class="font-medium text-accent text-xs font-mono truncate">{t.name || t.Name}</span>
                                  <span class="text-2xs px-1.5 py-0.5 rounded-md bg-surface-subtle border border-border text-fg-muted font-mono shrink-0">
                                    {t.deferred || t.Deferred ? "Deferred" : "Active"}
                                  </span>
                                </div>
                                <p class="text-xs text-fg-secondary mb-2 font-sans">{t.description || t.Description}</p>
                                <JsonHighlightViewer
                                  data={t.schema || t.Schema || t.input_schema}
                                  title="Parameter JSON schema"
                                  maxHeight="250px"
                                />
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>

                      {/* Sub-tab 5: Headers & Summary */}
                      <Show when={payloadSubTab() === "headers"}>
                        <div class="flex flex-col gap-3">
                          <div class="bg-surface p-4 rounded-panel border border-border flex flex-col gap-2">
                            <span class="font-medium text-fg text-xs border-b border-border-subtle pb-1.5 mb-1">
                              General request details
                            </span>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                              <div class="min-w-0 break-all"><span class="text-fg-muted">Request URL:</span> {req().endpoint}</div>
                              <div><span class="text-fg-muted">Request method:</span> POST</div>
                              <div class="min-w-0 break-all"><span class="text-fg-muted">Model ID:</span> {req().model}</div>
                              <div><span class="text-fg-muted">Reasoning tier:</span> {req().reasoning || "default"}</div>
                              <div><span class="text-fg-muted">Max tokens:</span> {req().maxTokens}</div>
                              <div class="min-w-0 break-all"><span class="text-fg-muted">Session ID:</span> {req().sessionId}</div>
                              <div><span class="text-fg-muted">Turn index:</span> #{req().turnIndex}</div>
                              <div><span class="text-fg-muted">Step index:</span> #{req().step}</div>
                              <div><span class="text-fg-muted">Simulated:</span> {req().isSimulated ? "Yes (smoke test)" : "No (live wire)"}</div>
                            </div>
                          </div>

                          <Show when={req().usage}>
                            <div class="bg-surface p-4 rounded-panel border border-border flex flex-col gap-2">
                              <span class="font-medium text-fg text-xs border-b border-border-subtle pb-1.5 mb-1">
                                Token usage
                              </span>
                              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs tabular-nums">
                                <div><span class="text-fg-muted">Input tokens:</span> {req().usage.inputTokens ?? req().usage.input ?? 0}</div>
                                <div><span class="text-fg-muted">Output tokens:</span> {req().usage.outputTokens ?? req().usage.output ?? 0}</div>
                                <div><span class="text-fg-muted">Cache read:</span> {req().usage.cacheReadTokens ?? 0}</div>
                                <div><span class="text-fg-muted">Cache write:</span> {req().usage.cacheWriteTokens ?? 0}</div>
                              </div>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>

        {/* 2. LIVE EVENT STREAM TAB */}
        <Show when={activeTab() === "stream"}>
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-background font-mono">
            {/* Stream toolbar */}
            <div class="px-4 py-2 bg-surface-subtle border-b border-border flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
              <div class="flex flex-wrap items-center gap-3 min-w-0">
                <span class="font-medium text-fg">Event filter:</span>
                <select
                  value={eventFilter()}
                  onChange={(e) => setEventFilter(e.currentTarget.value)}
                  class="bg-surface border border-border rounded-control px-2 py-1 max-sm:text-base sm:text-xs text-fg focus:outline-none focus:border-accent"
                >
                  <option value="all">All events ({liveEvents().length})</option>
                  <option value="llm">LLM requests / responses</option>
                  <option value="tool">Tool calls & results</option>
                  <option value="text">Text & reasoning deltas</option>
                  <option value="turns">Turn lifecycle</option>
                </select>

                <label class="flex items-center gap-1.5 text-fg-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoScroll()}
                    onChange={(e) => setAutoScroll(e.currentTarget.checked)}
                    class="rounded bg-surface border-border"
                  />
                  Auto-scroll
                </label>
              </div>

              <div class="flex items-center gap-2">
                <button
                  onClick={() => {
                    setLiveEvents([]);
                    setLiveThinking("");
                    setLiveText("");
                  }}
                  class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1 hover:bg-danger-subtle hover:text-danger"
                >
                  <Icon name={Icons.trash} size={12} />
                  Clear stream
                </button>
              </div>
            </div>

            {/* Live Streaming Chains */}
            <Show when={liveThinking() || liveText()}>
              <div class="p-3 bg-surface-subtle border-b border-border shrink-0 flex flex-col gap-2 max-h-48 overflow-y-auto">
                <Show when={liveThinking()}>
                  <div class="bg-warning-subtle border border-warning/35 p-2.5 rounded-panel text-xs text-fg">
                    <div class="text-xs text-warning font-medium mb-1 flex items-center gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                      Live chain-of-thought (streaming)
                    </div>
                    <pre class="whitespace-pre-wrap text-xs leading-relaxed max-h-32 overflow-y-auto">
                      {liveThinking()}
                    </pre>
                  </div>
                </Show>

                <Show when={liveText()}>
                  <div class="bg-info-subtle border border-tone-sky/30 p-2.5 rounded-panel text-xs text-fg">
                    <div class="text-xs text-tone-sky font-medium mb-1 flex items-center gap-1.5">
                      <span class="w-1.5 h-1.5 rounded-full bg-tone-sky animate-pulse" />
                      Live assistant text (streaming)
                    </div>
                    <pre class="whitespace-pre-wrap text-xs leading-relaxed max-h-32 overflow-y-auto">
                      {liveText()}
                    </pre>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Stream Event List */}
            <div ref={streamContainerRef} class="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
              <Show
                when={filteredEvents().length > 0}
                fallback={
                  <div class="p-8 text-center text-fg-muted font-sans">
                    No events captured in this session yet. Events appear here in real time while a turn is running.
                  </div>
                }
              >
                <For each={filteredEvents()}>
                  {(ev) => {
                    const isExpanded = () => expandedEvents()[ev.id];
                    const toggle = () =>
                      setExpandedEvents((prev) => ({ ...prev, [ev.id]: !prev[ev.id] }));

                    return (
                      <div class="border border-border rounded-panel bg-surface overflow-hidden">
                        <div
                          onClick={toggle}
                          class="px-3 py-2 bg-surface hover:bg-surface-subtle flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none"
                        >
                          <div class="flex flex-wrap items-center gap-2 min-w-0">
                            <span class="text-2xs text-fg-muted tabular-nums">
                              {new Date(ev.timestamp).toLocaleTimeString()}
                            </span>
                            <span
                              class={`px-1.5 py-0.5 rounded-md text-2xs font-medium ${
                                ev.type === "debug_llm_request"
                                  ? "bg-accent-subtle text-tone-violet border border-tone-violet/30"
                                  : ev.type.startsWith("tool")
                                    ? "bg-warning-subtle text-warning border border-warning/35"
                                    : ev.type.startsWith("turn")
                                      ? "bg-info-subtle text-tone-sky border border-tone-sky/30"
                                      : "bg-surface-subtle text-fg-secondary border border-border"
                              }`}
                            >
                              {ev.type}
                            </span>
                            <Show when={ev.turnIndex != null}>
                              <span class="text-2xs text-fg-secondary font-mono tabular-nums">
                                Turn #{ev.turnIndex}
                              </span>
                            </Show>
                            <Show when={ev.data?.name}>
                              <span class="text-xs font-medium text-warning">
                                {ev.data.name}
                              </span>
                            </Show>
                          </div>
                          <span class="text-2xs text-fg-muted">
                            {isExpanded() ? "Collapse" : "Expand"}
                          </span>
                        </div>

                        <Show when={isExpanded()}>
                          <div class="p-3 bg-background/60 border-t border-border-subtle">
                            <JsonHighlightViewer data={ev.data} maxHeight="300px" />
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Show>

        {/* 3. SYSTEM PROMPT TAB */}
        <Show when={activeTab() === "system"}>
          <div class="flex-1 min-h-0 overflow-y-auto p-4 bg-background flex flex-col gap-3 font-mono">
            <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-border shrink-0">
              <div class="flex flex-col min-w-0">
                <span class="text-sm font-medium text-fg font-sans">
                  Full session system prompt
                </span>
                <span class="text-2xs text-fg-muted">
                  Computed by daemon for session: {selectedSessionId() || "(default)"} · Mode: {sessionMeta()?.mode || "agentic"}
                </span>
              </div>
              <div class="flex flex-wrap items-center gap-3">
                <span class="text-2xs text-fg-secondary tabular-nums">
                  Chars: {systemPrompt().length} · Words: {systemPrompt().split(/\s+/).length} · Est. tokens: ~{Math.round(systemPrompt().length / 4)}
                </span>
                <button
                  onClick={() => copyText(systemPrompt(), "System prompt")}
                  class="ui-button ui-button-outline ui-button-xs rounded-lg gap-1.5"
                >
                  <Icon name={Icons.copy} size={13} />
                  Copy system prompt
                </button>
              </div>
            </div>

            <pre class="bg-surface p-4 rounded-panel border border-border text-fg overflow-x-auto whitespace-pre-wrap text-xs leading-relaxed select-text flex-1">
              {systemPrompt() || "Loading system prompt from daemon…"}
            </pre>
          </div>
        </Show>

        {/* 4. NATIVE TOOLS CATALOG TAB */}
        <Show when={activeTab() === "tools"}>
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-background font-mono">
            <div class="px-4 py-2.5 bg-surface-subtle border-b border-border flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
              <div class="flex flex-wrap items-center gap-3 flex-1 min-w-0">
                <span class="font-medium text-fg font-sans shrink-0">Native tool catalog ({filteredTools().length})</span>
                <input
                  type="text"
                  placeholder="Search tools by name…"
                  value={toolSearch()}
                  onInput={(e) => setToolSearch(e.currentTarget.value)}
                  class="bg-surface border border-border rounded-control px-2.5 py-1 max-sm:text-base sm:text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent w-full sm:w-64 min-w-0"
                />
              </div>
              <span class="text-fg-muted text-2xs font-sans">
                Registered tools available in Indirect Code Go daemon
              </span>
            </div>

            <div class="flex-1 overflow-y-auto p-4 space-y-3">
              <For each={filteredTools()}>
                {(t) => {
                  const isExp = () => expandedTools()[t.name];
                  const toggle = () =>
                    setExpandedTools((prev) => ({ ...prev, [t.name]: !prev[t.name] }));

                  return (
                    <div class="border border-border rounded-panel bg-surface overflow-hidden">
                      <div
                        onClick={toggle}
                        class="p-3 bg-surface hover:bg-surface-subtle flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none"
                      >
                        <div class="flex flex-wrap items-center gap-2 min-w-0">
                          <span class="font-medium text-xs text-accent">{t.name}</span>
                          <Show when={t.isAuto}>
                            <span class="px-1.5 py-0.5 rounded-md bg-accent-subtle text-tone-violet text-2xs font-medium">
                              Auto tool
                            </span>
                          </Show>
                          <Show when={t.deferred}>
                            <span class="px-1.5 py-0.5 rounded-md bg-warning-subtle text-warning text-2xs">
                              Deferred
                            </span>
                          </Show>
                          <Show when={t.allowedModes && t.allowedModes.length > 0}>
                            <span class="text-2xs text-fg-muted">
                              Modes: {t.allowedModes?.join(", ")}
                            </span>
                          </Show>
                        </div>
                        <span class="text-2xs text-fg-muted">
                          {isExp() ? "Hide schema" : "View schema"}
                        </span>
                      </div>

                      <div class="px-3 py-2 text-xs text-fg-secondary border-t border-border-subtle font-sans">
                        {t.description}
                      </div>

                      <Show when={isExp()}>
                        <div class="p-3 bg-background/60 border-t border-border-subtle">
                          <JsonHighlightViewer
                            data={t.schema}
                            title={`${t.name} input schema`}
                            maxHeight="300px"
                          />
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* 5. RAW WS FRAMES TAB */}
        <Show when={activeTab() === "frames"}>
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-background font-mono">
            <div class="px-4 py-2 bg-surface-subtle border-b border-border flex items-center justify-between gap-2 shrink-0 text-xs">
              <span class="font-medium text-fg font-sans">
                Raw relay WebSocket frames ({rawFrames().length})
              </span>
              <button
                onClick={() => setRawFrames([])}
                class="ui-button ui-button-outline ui-button-xs rounded-lg hover:bg-danger-subtle hover:text-danger"
              >
                Clear frames
              </button>
            </div>

            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <For each={rawFrames()}>
                {(f) => (
                  <div class="border border-border rounded-panel bg-surface p-2.5 text-xs">
                    <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5 text-xs">
                      <div class="flex flex-wrap items-center gap-2 min-w-0">
                        <span class="text-2xs text-fg-muted tabular-nums">
                          {new Date(f.timestamp).toLocaleTimeString()}
                        </span>
                        <span
                          class={`px-1.5 py-0.5 rounded-md text-2xs font-medium ${
                            f.direction === "out"
                              ? "bg-warning-subtle text-warning border border-warning/35"
                              : "bg-info-subtle text-tone-sky border border-tone-sky/30"
                          }`}
                        >
                          {f.direction === "out" ? "OUT" : "IN"}
                        </span>
                        <span class="font-medium text-accent">{f.type}</span>
                        <Show when={f.sessionId}>
                          <span class="text-fg-muted text-2xs">
                            sid: {f.sessionId ? f.sessionId.slice(0, 8) : ""}
                          </span>
                        </Show>
                      </div>
                      <span class="text-2xs text-fg-muted tabular-nums">{f.size} bytes</span>
                    </div>
                    <JsonHighlightViewer data={f.payload} maxHeight="180px" />
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* 6. WAL STATE TAB */}
        <Show when={activeTab() === "wal"}>
          <div class="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden font-mono text-xs">
            {/* Left list: WAL event sequence */}
            <div class="w-full max-h-56 lg:max-h-none lg:w-80 border-b lg:border-b-0 lg:border-r border-border bg-surface-subtle flex flex-col shrink-0">
              <div class="px-3 py-2 bg-surface-subtle border-b border-border-subtle flex items-center justify-between gap-2 shrink-0">
                <span class="font-medium text-fg text-xs font-sans shrink-0">WAL events ({filteredWalEvents().length})</span>
                <input
                  type="text"
                  placeholder="Filter events…"
                  value={walFilter()}
                  onInput={(e) => setWalFilter(e.currentTarget.value)}
                  class="bg-surface border border-border rounded-control px-2 py-0.5 max-sm:text-base sm:text-xs text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent min-w-0 w-36"
                />
              </div>

              <div class="flex-1 overflow-y-auto divide-y divide-border-subtle">
                <Show
                  when={filteredWalEvents().length > 0}
                  fallback={
                    <div class="p-8 text-center text-xs text-fg-muted font-sans">
                      No WAL events available for this session.
                    </div>
                  }
                >
                  <For each={filteredWalEvents()}>
                    {(ev) => {
                      const isSel = () => selectedWalSeq() === ev.seq || (selectedWalSeq() === null && filteredWalEvents()[0]?.seq === ev.seq);
                      const typeBadgeColor = (type: string) => {
                        switch (type) {
                          case "header": return "bg-warning-subtle text-warning border-warning/35";
                          case "options": return "bg-accent-subtle text-tone-violet border-tone-violet/30";
                          case "msg": return "bg-success-subtle text-success border-success/35";
                          case "title": return "bg-info-subtle text-tone-sky border-tone-sky/30";
                          case "usage": return "bg-success-subtle text-tone-teal border-tone-teal/30";
                          case "todos": return "bg-info-subtle text-tone-sky border-tone-sky/30";
                          case "widgets": return "bg-danger-subtle text-tone-rose border-tone-rose/30";
                          default: return "bg-surface text-fg-secondary border-border";
                        }
                      };

                      return (
                        <button
                          type="button"
                          onClick={() => setSelectedWalSeq(ev.seq)}
                          class={`w-full text-left p-2.5 transition-colors cursor-pointer flex flex-col gap-1 border-l-2 ${
                            isSel()
                              ? "bg-accent-subtle border-accent text-fg"
                              : "border-transparent hover:bg-surface-muted/70 text-fg-secondary"
                          }`}
                        >
                          <div class="flex items-center justify-between text-xs">
                            <div class="flex items-center gap-1.5">
                              <span class="text-fg-muted font-medium tabular-nums">#{ev.seq}</span>
                              <span class={`px-1.5 py-0.5 rounded-md text-2xs font-medium border ${typeBadgeColor(ev.type)}`}>
                                {ev.type}
                              </span>
                            </div>
                            <Show when={ev.timestamp}>
                              <span class="text-2xs text-fg-muted tabular-nums">
                                {new Date(ev.timestamp!).toLocaleTimeString()}
                              </span>
                            </Show>
                          </div>
                          <div class="text-2xs text-fg-muted truncate">
                            {ev.type === "msg" ? (ev.payload?.model || ev.payload?.endpoint || "turn message") :
                             ev.type === "header" ? `turnSeq ${ev.payload?.turnIndex || 1} · ${ev.payload?.model || ""}` :
                             ev.type === "options" ? `mode ${ev.payload?.mode || "agentic"}` :
                             ev.type === "title" ? (ev.payload?.title || "") :
                             JSON.stringify(ev.payload || {}).slice(0, 40)}
                          </div>
                        </button>
                      );
                    }}
                  </For>
                </Show>
              </div>
            </div>

            {/* Right Pane: Structured Payload Inspector */}
            <div class="flex-1 min-h-0 flex flex-col bg-background overflow-hidden">
              <Show
                when={selectedWalEvent()}
                fallback={
                  <div class="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-fg-muted font-sans gap-2">
                    <Icon name="lucide:database" size={24} />
                    <span>Select a WAL event on the left to inspect its state.</span>
                  </div>
                }
              >
                {(ev) => (
                  <div class="flex-1 flex flex-col min-h-0">
                    <div class="px-4 py-2 bg-surface-subtle border-b border-border flex flex-wrap items-center justify-between gap-2 shrink-0 text-xs">
                      <div class="flex flex-wrap items-center gap-3 min-w-0">
                        <span class="font-medium text-fg-secondary tabular-nums">Event #{ev().seq}</span>
                        <span class="font-medium text-accent">{ev().type}</span>
                        <Show when={ev().timestamp}>
                          <span class="text-fg-muted text-2xs tabular-nums">
                            {new Date(ev().timestamp!).toLocaleTimeString()} ({new Date(ev().timestamp!).toISOString()})
                          </span>
                        </Show>
                      </div>
                      <span class="text-2xs text-fg-muted font-sans">WAL append-only state</span>
                    </div>

                    <div class="flex-1 overflow-hidden p-4">
                      <JsonHighlightViewer
                        data={ev().payload}
                        title={`WAL event #${ev().seq} (${ev().type}) payload`}
                        maxHeight="calc(100vh - 230px)"
                        class="h-full"
                      />
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>

      {/* ===== BOTTOM BAR: SMOKE SIMULATOR & PROMPT SENDER ===== */}
      <footer class="px-4 py-2.5 bg-surface-subtle border-t border-border shrink-0 flex flex-wrap items-center gap-2 text-xs z-20">
        <span class="text-fg-secondary shrink-0 font-medium">Prompt action:</span>
        <input
          type="text"
          placeholder="Type a prompt to send or simulate (smoke test)…"
          value={promptInput()}
          onInput={(e) => setPromptInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) {
                runSmokeSimulation();
              } else {
                sendQuickPrompt();
              }
            }
          }}
          class="min-w-0 flex-1 basis-48 bg-surface border border-border-strong rounded-control px-3 py-1.5 max-sm:text-base sm:text-xs font-mono text-fg placeholder:text-fg-muted focus:outline-none focus:border-accent"
        />

        {/* Smoke Simulation Button */}
        <button
          type="button"
          onClick={runSmokeSimulation}
          disabled={isSimulating()}
          class="ui-button ui-button-outline ui-button-sm rounded-lg gap-1.5 border-warning/35 bg-warning-subtle text-warning hover:bg-warning/15 shrink-0"
          data-rc-tip="Simulate prompt right now without calling LLM (0 tokens billed)"
        >
          <Icon name="lucide:flame" size={13} />
          {isSimulating() ? "Simulating…" : "Smoke test"}
        </button>

        {/* Live Send Button */}
        <button
          type="button"
          onClick={sendQuickPrompt}
          disabled={!promptInput().trim() || !selectedSessionId()}
          class="ui-button ui-button-primary ui-button-sm rounded-lg gap-1.5 shrink-0"
          data-rc-tip="Send real turn prompt to the session"
        >
          <Icon name={Icons.send} size={13} />
          Send prompt
        </button>
      </footer>
    </div>
  );
}
