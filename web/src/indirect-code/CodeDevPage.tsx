import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  Show,
  For,
  batch,
} from "solid-js";
import { createHosts } from "./hooks/useHosts";
import { createRelay } from "./hooks/useRelay";
import { createMirror } from "./hooks/useMirror";
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
  sessionId?: string;
  size: number;
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
          return `<span class="text-sky-300 font-semibold">${keyPart}</span><span class="text-ink-400">${colonPart}</span>`;
        }
        return `<span class="text-emerald-300">${match}</span>`;
      }
      if (/true|false/.test(match)) {
        return `<span class="text-amber-400 font-bold">${match}</span>`;
      }
      if (/null/.test(match)) {
        return `<span class="text-rose-400 italic font-semibold">${match}</span>`;
      }
      return `<span class="text-purple-300 font-mono">${match}</span>`;
    },
  );

  if (searchMatch && searchMatch.trim()) {
    const q = searchMatch.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${q})`, "gi");
    escaped = escaped.replace(re, `<mark class="bg-amber-400 text-ink-950 rounded px-0.5 font-bold">$1</mark>`);
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
      if (typeof props.data === "string") {
        return isCompact()
          ? JSON.stringify(JSON.parse(props.data))
          : JSON.stringify(JSON.parse(props.data), null, 2);
      }
      return isCompact()
        ? JSON.stringify(props.data)
        : JSON.stringify(props.data, null, 2);
    } catch {
      return String(props.data);
    }
  });

  const lines = createMemo(() => formattedStr().split("\n"));

  function copyJson() {
    navigator.clipboard.writeText(formattedStr());
    toast("JSON copied to clipboard", "ok");
  }

  function downloadJson() {
    const blob = new Blob([formattedStr()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payload_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Downloaded JSON", "ok");
  }

  return (
    <div class={`flex flex-col border border-line rounded-lg bg-ink-900/90 overflow-hidden font-mono text-xs ${props.class || ""}`}>
      {/* Viewer toolbar */}
      <div class="px-3 py-1.5 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 gap-2 text-[11px]">
        <div class="flex items-center gap-2">
          <Show when={props.title}>
            <span class="font-bold text-ink-300 uppercase tracking-wider text-[10px]">
              {props.title}
            </span>
          </Show>
          <span class="text-ink-500 text-[10px]">
            {lines().length} lines • {new Blob([formattedStr()]).size} bytes
          </span>
        </div>

        <div class="flex items-center gap-2">
          {/* Quick search input */}
          <div class="relative flex items-center">
            <input
              type="text"
              placeholder="Find in JSON..."
              value={search()}
              onInput={(e) => setSearch(e.currentTarget.value)}
              class="bg-ink-950 border border-line rounded px-2 py-0.5 text-[11px] text-ink-200 placeholder-ink-600 focus:outline-none focus:border-brand-500 w-36"
            />
            <Show when={search()}>
              <button
                onClick={() => setSearch("")}
                class="absolute right-1 text-ink-400 hover:text-ink-200 text-xs cursor-pointer"
              >
                ×
              </button>
            </Show>
          </div>

          {/* Pretty / Compact toggle */}
          <button
            onClick={() => setIsCompact(!isCompact())}
            class="px-2 py-0.5 bg-ink-800 hover:bg-ink-700 text-ink-300 rounded border border-line text-[10px] cursor-pointer"
            title="Toggle compact or pretty JSON"
          >
            {isCompact() ? "Pretty" : "Compact"}
          </button>

          {/* Copy Button */}
          <button
            onClick={copyJson}
            class="px-2 py-0.5 bg-ink-800 hover:bg-ink-700 text-brand-400 rounded border border-line text-[10px] flex items-center gap-1 cursor-pointer"
            title="Copy full JSON"
          >
            <Icon name={Icons.copy} size={11} />
            Copy
          </button>

          {/* Download Button */}
          <button
            onClick={downloadJson}
            class="px-2 py-0.5 bg-ink-800 hover:bg-ink-700 text-ink-300 rounded border border-line text-[10px] flex items-center gap-1 cursor-pointer"
            title="Download JSON file"
          >
            <Icon name={Icons.save} size={11} />
            Download
          </button>
        </div>
      </div>

      {/* Code body with line numbers */}
      <div
        class="overflow-auto bg-ink-950 p-2 text-[12px] leading-relaxed select-text"
        style={{ "max-height": props.maxHeight || "none" }}
      >
        <table class="border-collapse w-full">
          <tbody>
            <For each={lines()}>
              {(line, idx) => (
                <tr class="hover:bg-ink-900/60 transition-colors">
                  <td class="select-none text-right pr-3 text-ink-600 font-mono text-[11px] w-12 align-top tabular-nums border-r border-line/30">
                    {idx() + 1}
                  </td>
                  <td
                    class="pl-3 whitespace-pre font-mono text-ink-200 align-top"
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
    "payloads" | "stream" | "system" | "tools" | "frames"
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

  // Initialize Hosts
  const hosts = createHosts({
    toast: (msg, kind) => toast(msg, kind),
    showConfirm: async (opts) => confirm(opts.message || "Confirm?"),
  });

  // Relay connection
  const relay = createRelay({
    getHostId: () => hosts.activeHostId(),
    onMessage: (data: unknown) => {
      const msg = data as any;
      if (!msg) return;

      const now = Date.now();
      const rawStr = JSON.stringify(msg);

      // Record raw frame (frontend-only, up to 300)
      setRawFrames((prev) => [
        {
          id: `frame_${now}_${Math.random().toString(36).slice(2, 7)}`,
          timestamp: now,
          type: msg.type || "unknown",
          sessionId: msg.sessionId || msg.session?.id,
          size: rawStr.length,
          payload: msg,
        },
        ...prev.slice(0, 300),
      ]);

      // Handle session debug data
      if (msg.type === "session_debug_data") {
        if (msg.systemPrompt) setSystemPrompt(msg.systemPrompt);
        if (msg.tools && Array.isArray(msg.tools)) setNativeTools(msg.tools);
        if (msg.session) setSessionMeta(msg.session);
      }

      // Handle Smoke Simulation Result
      if (msg.type === "preview_prompt_result") {
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
          toast("🔥 Smoke simulation payload captured (0 tokens billed)", "ok");
        } else if (msg.error) {
          toast(`Simulation error: ${msg.error}`, "err");
        }
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
    await hosts.loadHosts();
    const hid = hosts.activeHostId();
    if (hid) {
      relay.connect(hid);
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
        (p.isSimulated && "smoke".includes(q)),
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

  /**
   * Chrome DevTools Network Tab Clear Button:
   * Wipes the frontend-captured requests, live events, and frames!
   */
  function clearAllNetworkLogs() {
    setCapturedPayloads([]);
    setSelectedPayloadId("");
    setLiveEvents([]);
    setRawFrames([]);
    setLiveThinking("");
    setLiveText("");
    toast("Network log cleared", "ok");
  }

  /**
   * Quick Prompt: dispatches real turn prompt to the session.
   */
  function sendQuickPrompt() {
    const text = promptInput().trim();
    const sid = selectedSessionId();
    const hid = hosts.activeHostId();
    if (!text || !sid || !hid) return;

    relay.send({
      type: "prompt",
      sessionId: sid,
      text,
      hostId: hid,
      model: "",
      yolo: true,
      options: { mode: "agentic", effort: "default", access: "full", skills: [] },
      attachmentIds: [],
      requestId: `prompt_${Date.now()}`,
    } as any);
    setPromptInput("");
    toast("Prompt dispatched to session", "ok");
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

    setIsSimulating(true);
    relay.send({
      type: "preview_prompt" as any,
      sessionId: sid,
      text: promptInput().trim(),
      hostId: hid,
      requestId: `smoke_${Date.now()}`,
    } as any);
  }

  function copyText(val: string, label = "Copied") {
    navigator.clipboard.writeText(val);
    toast(`${label} to clipboard`, "ok");
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
    <div class="flex flex-col h-screen w-screen bg-ink-950 text-ink-100 font-sans select-text overflow-hidden">
      {/* ===== TOP BAR / HEADER ===== */}
      <header class="flex items-center justify-between px-4 py-2 bg-ink-900 border-b border-line shrink-0 gap-3 z-20">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded bg-brand-500/20 text-brand-400 font-mono font-bold text-xs border border-brand-500/40 shadow-sm">
              DEV
            </span>
            <div class="flex flex-col">
              <span class="font-bold text-sm tracking-tight flex items-center gap-1.5 font-mono">
                INDIRECT CODE // NETWORK INSPECTOR
                <span class="text-[10px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-mono font-normal">
                  CHROME DEVTOOLS STYLE
                </span>
              </span>
              <span class="text-[11px] text-ink-400 font-mono">
                Exact AI Wire Payloads, Full System Prompt & Native Tools
              </span>
            </div>
          </div>

          <div class="h-5 w-px bg-line mx-1" />

          {/* Host Selector */}
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-ink-400 font-mono">Host:</span>
            <select
              value={hosts.activeHostId()}
              onChange={(e) => hosts.setActiveHostId(e.currentTarget.value)}
              class="bg-ink-800 border border-line rounded px-2 py-1 text-xs font-mono text-ink-200 focus:outline-none focus:border-brand-500"
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
          <div class="flex items-center gap-1.5 max-w-xs">
            <span class="text-xs text-ink-400 font-mono">Session:</span>
            <select
              value={selectedSessionId()}
              onChange={(e) => setSelectedSessionId(e.currentTarget.value)}
              class="bg-ink-800 border border-line rounded px-2 py-1 text-xs font-mono text-ink-200 focus:outline-none focus:border-brand-500 truncate"
            >
              <option value="">-- No session (Default) --</option>
              <For each={sessions()}>
                {(s) => (
                  <option value={s.id}>
                    {s.status === "running" ? "▶ [RUNNING] " : "[IDLE] "}
                    {s.title ? (s.title.length > 25 ? s.title.slice(0, 25) + "…" : s.title) : s.id.slice(0, 8)} ({s.model || "default"})
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Status Badge */}
          <Show when={activeSession()}>
            <span
              class={`text-[11px] px-2 py-0.5 rounded font-mono font-semibold flex items-center gap-1.5 ${
                activeSession()?.status === "running"
                  ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse"
                  : "bg-ink-800 text-ink-400 border border-line"
              }`}
            >
              <span
                class={`w-1.5 h-1.5 rounded-full ${
                  activeSession()?.status === "running" ? "bg-emerald-400" : "bg-ink-500"
                }`}
              />
              {activeSession()?.status?.toUpperCase()}
            </span>
          </Show>
        </div>

        {/* Action Controls */}
        <div class="flex items-center gap-2">
          {/* Preserve Log Toggle */}
          <label
            class="flex items-center gap-1 text-[11px] text-ink-400 hover:text-ink-200 cursor-pointer font-mono mr-2"
            title="Preserve captured logs across session switches"
          >
            <input
              type="checkbox"
              checked={preserveLog()}
              onChange={(e) => setPreserveLog(e.currentTarget.checked)}
              class="rounded bg-ink-800 border-line"
            />
            Preserve log
          </label>

          {/* Chrome-Style Clear Network Log Button */}
          <button
            onClick={clearAllNetworkLogs}
            class="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-ink-800 hover:bg-rose-950/40 hover:text-rose-400 text-ink-300 rounded border border-line font-mono transition-colors cursor-pointer"
            title="Clear all recorded network payloads and events (Frontend-only)"
          >
            <span class="text-rose-400 font-bold">🚫</span>
            Clear Log
          </button>

          {/* WS Connection Indicator */}
          <span
            class={`text-[10px] font-mono px-2 py-0.5 rounded flex items-center gap-1 ${
              relay.wsOpen()
                ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                : "bg-rose-950 text-rose-400 border border-rose-800"
            }`}
          >
            <span
              class={`w-1.5 h-1.5 rounded-full ${relay.wsOpen() ? "bg-emerald-400" : "bg-rose-400"}`}
            />
            {relay.wsOpen() ? "RELAY LIVE" : "DISCONNECTED"}
          </span>

          <button
            onClick={requestSessionDebug}
            class="flex items-center gap-1 px-2.5 py-1 text-xs bg-ink-800 hover:bg-ink-700 text-ink-200 rounded border border-line font-mono transition-colors cursor-pointer"
            title="Refresh daemon debug state"
          >
            <Icon name={Icons.refresh} size={13} />
            Refresh
          </button>
        </div>
      </header>

      {/* ===== MAIN NAV TABS ===== */}
      <div class="flex items-center px-4 bg-ink-900 border-b border-line shrink-0 gap-1 text-xs font-mono">
        <button
          onClick={() => setActiveTab("payloads")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "payloads"
              ? "border-brand-500 text-brand-400 bg-brand-500/10"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          <Icon name={Icons.bolt} size={14} />
          Network Payloads ({capturedPayloads().length})
        </button>

        <button
          onClick={() => setActiveTab("stream")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "stream"
              ? "border-brand-500 text-brand-400 bg-brand-500/10"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          <Icon name={Icons.play} size={14} />
          Live Event Stream ({liveEvents().length})
          <Show when={activeSession()?.status === "running"}>
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
          </Show>
        </button>

        <button
          onClick={() => setActiveTab("system")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "system"
              ? "border-brand-500 text-brand-400 bg-brand-500/10"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          <Icon name={Icons.file} size={14} />
          System Prompt (Full)
        </button>

        <button
          onClick={() => setActiveTab("tools")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "tools"
              ? "border-brand-500 text-brand-400 bg-brand-500/10"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          <Icon name={Icons.terminal} size={14} />
          Native Tools ({nativeTools().length})
        </button>

        <button
          onClick={() => setActiveTab("frames")}
          class={`px-3 py-2 font-medium border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
            activeTab() === "frames"
              ? "border-brand-500 text-brand-400 bg-brand-500/10"
              : "border-transparent text-ink-400 hover:text-ink-200"
          }`}
        >
          <Icon name={Icons.layers} size={14} />
          WS Frames ({rawFrames().length})
        </button>
      </div>

      {/* ===== BODY CONTENT PANES ===== */}
      <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
        {/* 1. LLM PAYLOADS TAB (Chrome DevTools Network Style) */}
        <Show when={activeTab() === "payloads"}>
          <div class="flex-1 min-h-0 flex overflow-hidden">
            {/* Left Pane: Requests Network Table / List */}
            <div class="w-88 border-r border-line bg-ink-900/60 flex flex-col shrink-0">
              {/* Table search & counter */}
              <div class="p-2 border-b border-line flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Filter requests..."
                  value={requestFilter()}
                  onInput={(e) => setRequestFilter(e.currentTarget.value)}
                  class="bg-ink-950 border border-line rounded px-2.5 py-1 text-xs font-mono text-ink-200 placeholder-ink-600 focus:outline-none focus:border-brand-500 flex-1"
                />
                <button
                  onClick={clearAllNetworkLogs}
                  class="p-1 hover:bg-rose-900/40 rounded text-ink-400 hover:text-rose-400 cursor-pointer"
                  title="Clear requests log"
                >
                  <Icon name={Icons.trash} size={14} />
                </button>
              </div>

              {/* Request rows */}
              <div class="flex-1 overflow-y-auto divide-y divide-line/30 font-mono text-xs">
                <Show
                  when={filteredCapturedPayloads().length > 0}
                  fallback={
                    <div class="p-8 text-center text-xs text-ink-500 flex flex-col items-center gap-2">
                      <span>No requests captured yet.</span>
                      <span class="text-[11px] text-ink-600">
                        Recordings stay in your browser until you clear them. Disparate a real prompt or click "🔥 Smoke Test" below!
                      </span>
                    </div>
                  }
                >
                  <For each={filteredCapturedPayloads()}>
                    {(req) => (
                      <button
                        onClick={() => setSelectedPayloadId(req.id)}
                        class={`w-full text-left p-2.5 transition-colors cursor-pointer flex flex-col gap-1 border-l-3 ${
                          selectedPayload()?.id === req.id
                            ? req.isSimulated
                              ? "bg-amber-500/15 border-amber-500 text-ink-100"
                              : "bg-brand-500/15 border-brand-500 text-ink-100"
                            : req.isSimulated
                              ? "border-amber-500/40 hover:bg-ink-800/40 text-ink-300"
                              : "border-transparent hover:bg-ink-800/40 text-ink-300"
                        }`}
                      >
                        <div class="flex items-center justify-between text-[11px]">
                          <div class="flex items-center gap-1.5">
                            <span
                              class={`w-2 h-2 rounded-full ${
                                req.isSimulated
                                  ? "bg-amber-400"
                                  : req.stopReason === "error"
                                    ? "bg-rose-500"
                                    : "bg-emerald-400"
                              }`}
                            />
                            <span class="font-bold text-ink-200">
                              POST /messages
                            </span>
                          </div>
                          <span class="text-[10px] text-ink-500 tabular-nums">
                            {new Date(req.timestamp).toLocaleTimeString()}
                          </span>
                        </div>

                        <div class="flex items-center justify-between text-[11px]">
                          <span class="truncate text-ink-400">
                            {req.model || "default"}
                          </span>
                          <Show when={req.isSimulated}>
                            <span class="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30">
                              🔥 SMOKE
                            </span>
                          </Show>
                        </div>

                        <div class="flex items-center gap-1.5 text-[10px] text-ink-500 mt-0.5">
                          <span>T#{req.turnIndex} S#{req.step}</span>
                          <span>•</span>
                          <span>{req.tools?.length || 0} tools</span>
                          <span>•</span>
                          <span>{req.messages?.length || 0} msgs</span>
                          <Show when={req.usage?.outputTokens}>
                            <span>•</span>
                            <span class="text-emerald-400 font-medium">
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
            <div class="flex-1 min-h-0 flex flex-col bg-ink-950 overflow-hidden">
              <Show
                when={selectedPayload()}
                fallback={
                  <div class="flex-1 flex flex-col items-center justify-center text-xs font-mono text-ink-500 gap-2">
                    <Icon name={Icons.bolt} size={28} />
                    <span>Select a captured request or run a Smoke Simulation below</span>
                  </div>
                }
              >
                {(req) => (
                  <div class="flex-1 flex flex-col min-h-0">
                    {/* Header banner info */}
                    <div class="px-4 py-2 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 font-mono text-xs">
                      <div class="flex items-center gap-3">
                        <Show when={req().isSimulated}>
                          <span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40 text-[11px] flex items-center gap-1">
                            🔥 SMOKE SIMULATION (0 TOKENS)
                          </span>
                        </Show>
                        <span class="font-bold text-brand-400">
                          {req().endpoint || "POST /messages"}
                        </span>
                        <span class="text-ink-400">
                          Model: <strong class="text-ink-200">{req().model}</strong>
                        </span>
                        <Show when={req().reasoning}>
                          <span class="text-ink-400">
                            Effort: <strong class="text-amber-300">{req().reasoning}</strong>
                          </span>
                        </Show>
                        <span class="text-ink-400">
                          MaxTokens: <strong class="text-ink-200">{req().maxTokens}</strong>
                        </span>
                      </div>

                      <div class="flex items-center gap-2">
                        <span class="text-ink-500 text-[11px]">
                          {new Date(req().timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>

                    {/* Inspector Sub-Tabs (Chrome Network style) */}
                    <div class="flex items-center px-4 bg-ink-900/60 border-b border-line shrink-0 gap-1 text-[11px] font-mono">
                      <button
                        onClick={() => setPayloadSubTab("raw")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "raw"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Wire Payload (Raw HTTP Body)
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("system")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "system"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        System Prompt in Request
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("messages")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "messages"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Messages ({req().messages?.length || 0})
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("tools")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "tools"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Tools in Request ({req().tools?.length || 0})
                      </button>

                      <button
                        onClick={() => setPayloadSubTab("headers")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "headers"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Headers & Summary
                      </button>
                    </div>

                    {/* Sub-tab view body */}
                    <div class="flex-1 min-h-0 overflow-auto p-4 font-mono text-xs">
                      {/* Sub-tab 1: Raw Wire Payload JSON */}
                      <Show when={payloadSubTab() === "raw"}>
                        <JsonHighlightViewer
                          data={req().rawPayload}
                          title="Exact HTTP POST Request Body"
                          class="h-full"
                        />
                      </Show>

                      {/* Sub-tab 2: System Prompt */}
                      <Show when={payloadSubTab() === "system"}>
                        <div class="flex flex-col gap-3 h-full">
                          <div class="flex items-center justify-between text-xs text-ink-400 bg-ink-900/60 p-2.5 rounded border border-line">
                            <div class="flex items-center gap-3">
                              <span>Chars: <strong class="text-ink-200">{req().system?.length || 0}</strong></span>
                              <span>•</span>
                              <span>Words: <strong class="text-ink-200">{req().system?.split(/\s+/).length || 0}</strong></span>
                              <span>•</span>
                              <span>Est. Tokens: <strong class="text-amber-400">~{Math.round((req().system?.length || 0) / 4)}</strong></span>
                            </div>
                            <button
                              onClick={() => copyText(req().system, "System prompt")}
                              class="px-2.5 py-1 bg-ink-800 hover:bg-ink-700 text-brand-400 rounded border border-line text-xs flex items-center gap-1 cursor-pointer"
                            >
                              <Icon name={Icons.copy} size={12} />
                              Copy Prompt
                            </button>
                          </div>
                          <pre class="bg-ink-950 p-4 rounded-lg border border-line text-ink-200 overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed flex-1 select-text">
                            {req().system || "(No system prompt in this request)"}
                          </pre>
                        </div>
                      </Show>

                      {/* Sub-tab 3: Messages Array */}
                      <Show when={payloadSubTab() === "messages"}>
                        <div class="flex flex-col gap-3">
                          <For each={req().messages}>
                            {(m: any, idx) => (
                              <div class="border border-line rounded-lg bg-ink-900/50 overflow-hidden">
                                <div class="px-3 py-1.5 bg-ink-900 border-b border-line flex items-center justify-between text-[11px]">
                                  <span class="font-bold flex items-center gap-2">
                                    <span class="text-ink-500 font-mono">#{idx()}</span>
                                    <span
                                      class={`px-2 py-0.5 rounded text-[10px] uppercase font-mono font-bold ${
                                        m.role === "user"
                                          ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                          : m.role === "assistant"
                                            ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                            : "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                      }`}
                                    >
                                      {m.role}
                                    </span>
                                  </span>
                                  <span class="text-ink-500 text-[10px]">
                                    {Array.isArray(m.content) ? `${m.content.length} blocks` : "raw text"}
                                  </span>
                                </div>
                                <div class="p-3 text-[11px] overflow-x-auto">
                                  <Show
                                    when={Array.isArray(m.content)}
                                    fallback={
                                      <pre class="whitespace-pre-wrap text-ink-200">{String(m.content)}</pre>
                                    }
                                  >
                                    <div class="flex flex-col gap-2">
                                      <For each={m.content}>
                                        {(block: any) => (
                                          <div class="bg-ink-950 p-3 rounded border border-line/60">
                                            <div class="text-[10px] text-ink-400 mb-1 font-bold">
                                              BLOCK: {block.type || (block.Text ? "text" : "data")}
                                            </div>
                                            <Show
                                              when={block.type === "text" || block.Text}
                                              fallback={<JsonHighlightViewer data={block} maxHeight="200px" />}
                                            >
                                              <pre class="whitespace-pre-wrap text-ink-200 text-[12px] leading-relaxed">
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
                              <div class="border border-line rounded-lg bg-ink-900/50 p-3">
                                <div class="flex items-center justify-between mb-1.5">
                                  <span class="font-bold text-brand-400 text-xs font-mono">{t.name || t.Name}</span>
                                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-400 font-mono">
                                    {t.deferred || t.Deferred ? "DEFERRED" : "ACTIVE"}
                                  </span>
                                </div>
                                <p class="text-xs text-ink-300 mb-2">{t.description || t.Description}</p>
                                <JsonHighlightViewer
                                  data={t.schema || t.Schema || t.input_schema}
                                  title="Parameter JSON Schema"
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
                          <div class="bg-ink-900/60 p-4 rounded-lg border border-line flex flex-col gap-2">
                            <span class="font-bold text-ink-200 text-xs border-b border-line pb-1 mb-1">
                              General Request Details
                            </span>
                            <div class="grid grid-cols-2 gap-2 text-xs">
                              <div><span class="text-ink-400">Request URL:</span> {req().endpoint}</div>
                              <div><span class="text-ink-400">Request Method:</span> POST</div>
                              <div><span class="text-ink-400">Model ID:</span> {req().model}</div>
                              <div><span class="text-ink-400">Reasoning Tier:</span> {req().reasoning || "default"}</div>
                              <div><span class="text-ink-400">Max Tokens:</span> {req().maxTokens}</div>
                              <div><span class="text-ink-400">Session ID:</span> {req().sessionId}</div>
                              <div><span class="text-ink-400">Turn Index:</span> #{req().turnIndex}</div>
                              <div><span class="text-ink-400">Step Index:</span> #{req().step}</div>
                              <div><span class="text-ink-400">Simulated:</span> {req().isSimulated ? "Yes (Smoke Test)" : "No (Live Wire)"}</div>
                            </div>
                          </div>

                          <Show when={req().usage}>
                            <div class="bg-ink-900/60 p-4 rounded-lg border border-line flex flex-col gap-2">
                              <span class="font-bold text-ink-200 text-xs border-b border-line pb-1 mb-1">
                                Token Usage & Costs
                              </span>
                              <div class="grid grid-cols-2 gap-2 text-xs">
                                <div><span class="text-ink-400">Input Tokens:</span> {req().usage.inputTokens ?? req().usage.input ?? 0}</div>
                                <div><span class="text-ink-400">Output Tokens:</span> {req().usage.outputTokens ?? req().usage.output ?? 0}</div>
                                <div><span class="text-ink-400">Cache Read:</span> {req().usage.cacheReadTokens ?? 0}</div>
                                <div><span class="text-ink-400">Cache Write:</span> {req().usage.cacheWriteTokens ?? 0}</div>
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
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-ink-950 font-mono">
            {/* Stream toolbar */}
            <div class="px-4 py-2 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 text-xs">
              <div class="flex items-center gap-3">
                <span class="font-bold text-ink-200">EVENT FILTER:</span>
                <select
                  value={eventFilter()}
                  onChange={(e) => setEventFilter(e.currentTarget.value)}
                  class="bg-ink-800 border border-line rounded px-2 py-1 text-xs text-ink-200 focus:outline-none"
                >
                  <option value="all">All Events ({liveEvents().length})</option>
                  <option value="llm">LLM Requests/Responses</option>
                  <option value="tool">Tool Calls & Results</option>
                  <option value="text">Text & Reasoning Deltas</option>
                  <option value="turns">Turn Lifecycle</option>
                </select>

                <label class="flex items-center gap-1.5 text-ink-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoScroll()}
                    onChange={(e) => setAutoScroll(e.currentTarget.checked)}
                    class="rounded bg-ink-800 border-line"
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
                  class="px-2.5 py-1 bg-ink-800 hover:bg-rose-950/40 hover:text-rose-400 text-ink-300 rounded border border-line text-xs flex items-center gap-1 cursor-pointer"
                >
                  <Icon name={Icons.trash} size={12} />
                  Clear Stream
                </button>
              </div>
            </div>

            {/* Live Streaming Chains */}
            <Show when={liveThinking() || liveText()}>
              <div class="p-3 bg-ink-900/80 border-b border-line shrink-0 flex flex-col gap-2 max-h-48 overflow-y-auto">
                <Show when={liveThinking()}>
                  <div class="bg-amber-950/30 border border-amber-900/40 p-2.5 rounded text-xs text-amber-200">
                    <div class="text-[10px] text-amber-400 font-bold mb-1 flex items-center gap-1">
                      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                      LIVE CHAIN-OF-THOUGHT (STREAMING)
                    </div>
                    <pre class="whitespace-pre-wrap text-[11px] leading-relaxed max-h-32 overflow-y-auto">
                      {liveThinking()}
                    </pre>
                  </div>
                </Show>

                <Show when={liveText()}>
                  <div class="bg-blue-950/30 border border-blue-900/40 p-2.5 rounded text-xs text-blue-200">
                    <div class="text-[10px] text-blue-400 font-bold mb-1 flex items-center gap-1">
                      <span class="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                      LIVE ASSISTANT TEXT (STREAMING)
                    </div>
                    <pre class="whitespace-pre-wrap text-[11px] leading-relaxed max-h-32 overflow-y-auto">
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
                  <div class="p-8 text-center text-ink-500">
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
                      <div class="border border-line rounded-lg bg-ink-900/40 overflow-hidden">
                        <div
                          onClick={toggle}
                          class="px-3 py-2 bg-ink-900/80 hover:bg-ink-800/80 flex items-center justify-between cursor-pointer select-none"
                        >
                          <div class="flex items-center gap-2">
                            <span class="text-[10px] text-ink-500 tabular-nums">
                              {new Date(ev.timestamp).toLocaleTimeString()}
                            </span>
                            <span
                              class={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                                ev.type === "debug_llm_request"
                                  ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                  : ev.type.startsWith("tool")
                                    ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                                    : ev.type.startsWith("turn")
                                      ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                      : "bg-ink-800 text-ink-300 border border-line"
                              }`}
                            >
                              {ev.type}
                            </span>
                            <Show when={ev.turnIndex != null}>
                              <span class="text-[10px] text-ink-400 font-mono">
                                Turn #{ev.turnIndex}
                              </span>
                            </Show>
                            <Show when={ev.data?.name}>
                              <span class="text-xs font-bold text-amber-300">
                                {ev.data.name}
                              </span>
                            </Show>
                          </div>
                          <span class="text-[10px] text-ink-500">
                            {isExpanded() ? "▲ collapse" : "▼ expand"}
                          </span>
                        </div>

                        <Show when={isExpanded()}>
                          <div class="p-3 bg-ink-950 border-t border-line">
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
          <div class="flex-1 min-h-0 overflow-y-auto p-4 bg-ink-950 flex flex-col gap-3 font-mono">
            <div class="flex items-center justify-between pb-2 border-b border-line shrink-0">
              <div class="flex flex-col">
                <span class="text-sm font-bold text-brand-400">
                  Full Session System Prompt
                </span>
                <span class="text-xs text-ink-400">
                  Computed by daemon for session: {selectedSessionId() || "(default)"} • Mode: {sessionMeta()?.mode || "agentic"}
                </span>
              </div>
              <div class="flex items-center gap-3">
                <span class="text-xs text-ink-400">
                  Chars: {systemPrompt().length} • Words: {systemPrompt().split(/\s+/).length} • Est. Tokens: ~{Math.round(systemPrompt().length / 4)}
                </span>
                <button
                  onClick={() => copyText(systemPrompt(), "System Prompt")}
                  class="px-3 py-1.5 bg-brand-500/20 text-brand-400 hover:bg-brand-500/30 rounded border border-brand-500/40 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
                >
                  <Icon name={Icons.copy} size={13} />
                  Copy System Prompt
                </button>
              </div>
            </div>

            <pre class="bg-ink-900 p-4 rounded-lg border border-line text-ink-200 overflow-x-auto whitespace-pre-wrap text-[12px] leading-relaxed select-text flex-1">
              {systemPrompt() || "Loading system prompt from daemon..."}
            </pre>
          </div>
        </Show>

        {/* 4. NATIVE TOOLS CATALOG TAB */}
        <Show when={activeTab() === "tools"}>
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-ink-950 font-mono">
            <div class="px-4 py-2.5 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 text-xs">
              <div class="flex items-center gap-3">
                <span class="font-bold text-brand-400">NATIVE TOOL CATALOG ({filteredTools().length})</span>
                <input
                  type="text"
                  placeholder="Search tools by name..."
                  value={toolSearch()}
                  onInput={(e) => setToolSearch(e.currentTarget.value)}
                  class="bg-ink-800 border border-line rounded px-2.5 py-1 text-xs text-ink-200 focus:outline-none w-64"
                />
              </div>
              <span class="text-ink-400 text-[11px]">
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
                    <div class="border border-line rounded-lg bg-ink-900/60 overflow-hidden">
                      <div
                        onClick={toggle}
                        class="p-3 bg-ink-900 hover:bg-ink-800/80 flex items-center justify-between cursor-pointer select-none"
                      >
                        <div class="flex items-center gap-2.5">
                          <span class="font-bold text-sm text-brand-400">{t.name}</span>
                          <Show when={t.isAuto}>
                            <span class="px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-400 text-[10px] font-bold">
                              AUTO TOOL
                            </span>
                          </Show>
                          <Show when={t.deferred}>
                            <span class="px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-400 text-[10px]">
                              DEFERRED
                            </span>
                          </Show>
                          <Show when={t.allowedModes && t.allowedModes.length > 0}>
                            <span class="text-[10px] text-ink-500">
                              Modes: {t.allowedModes?.join(", ")}
                            </span>
                          </Show>
                        </div>
                        <span class="text-[11px] text-ink-400">
                          {isExp() ? "Hide Schema ▲" : "View Schema ▼"}
                        </span>
                      </div>

                      <div class="px-3 py-2 text-xs text-ink-300 border-t border-line/40">
                        {t.description}
                      </div>

                      <Show when={isExp()}>
                        <div class="p-3 bg-ink-950 border-t border-line">
                          <JsonHighlightViewer
                            data={t.schema}
                            title={`${t.name} Input Schema`}
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
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden bg-ink-950 font-mono">
            <div class="px-4 py-2 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 text-xs">
              <span class="font-bold text-ink-200">
                RAW RELAY WEBSOCKET FRAMES ({rawFrames().length})
              </span>
              <button
                onClick={() => setRawFrames([])}
                class="px-2 py-0.5 bg-ink-800 hover:bg-rose-950/40 hover:text-rose-400 text-ink-300 rounded border border-line text-xs cursor-pointer"
              >
                Clear Frames
              </button>
            </div>

            <div class="flex-1 overflow-y-auto p-3 space-y-2">
              <For each={rawFrames()}>
                {(f) => (
                  <div class="border border-line rounded-lg bg-ink-900/40 p-2.5 text-xs">
                    <div class="flex items-center justify-between mb-1 text-[11px]">
                      <div class="flex items-center gap-2">
                        <span class="text-ink-500 tabular-nums">
                          {new Date(f.timestamp).toLocaleTimeString()}
                        </span>
                        <span class="font-bold text-brand-400">{f.type}</span>
                        <Show when={f.sessionId}>
                          <span class="text-ink-400 text-[10px]">
                            sid: {f.sessionId ? f.sessionId.slice(0, 8) : ""}
                          </span>
                        </Show>
                      </div>
                      <span class="text-[10px] text-ink-500">{f.size} bytes</span>
                    </div>
                    <JsonHighlightViewer data={f.payload} maxHeight="180px" />
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* ===== BOTTOM BAR: SMOKE SIMULATOR & PROMPT SENDER ===== */}
      <footer class="px-4 py-2.5 bg-ink-900 border-t border-line shrink-0 flex items-center gap-2.5 font-mono text-xs z-20">
        <span class="text-ink-400 shrink-0 font-bold">PROMPT ACTION:</span>
        <input
          type="text"
          placeholder="Type a prompt to send or simulate (Smoke Test)..."
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
          class="flex-1 bg-ink-950 border border-line rounded px-3 py-1.5 text-xs text-ink-100 placeholder-ink-600 focus:outline-none focus:border-brand-500"
        />

        {/* Smoke Simulation Button */}
        <button
          onClick={runSmokeSimulation}
          disabled={isSimulating()}
          class="px-3.5 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold rounded border border-amber-500/40 text-xs transition-colors cursor-pointer shrink-0 flex items-center gap-1.5 shadow-sm"
          title="Simulate prompt right now without calling LLM (0 tokens billed)"
        >
          <span>🔥</span>
          {isSimulating() ? "Simulating..." : "Smoke Test (Simulate Payload)"}
        </button>

        {/* Live Send Button */}
        <button
          onClick={sendQuickPrompt}
          disabled={!promptInput().trim() || !selectedSessionId()}
          class="px-3.5 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-ink-950 font-bold rounded text-xs transition-colors cursor-pointer shrink-0 flex items-center gap-1"
          title="Send real turn prompt to the session"
        >
          <Icon name={Icons.send} size={13} />
          Send Prompt
        </button>
      </footer>
    </div>
  );
}
