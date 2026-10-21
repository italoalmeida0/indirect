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

export default function CodeDevPage() {
  const [activeTab, setActiveTab] = createSignal<
    "payloads" | "stream" | "system" | "tools" | "frames"
  >("payloads");
  const [selectedSessionId, setSelectedSessionId] = createSignal<string>("");
  const [selectedPayloadId, setSelectedPayloadId] = createSignal<string>("");
  const [payloadSubTab, setPayloadSubTab] = createSignal<
    "raw" | "system" | "messages" | "tools"
  >("raw");

  // Debug data from daemon
  const [systemPrompt, setSystemPrompt] = createSignal<string>("");
  const [nativeTools, setNativeTools] = createSignal<DebugTool[]>([]);
  const [capturedPayloads, setCapturedPayloads] = createSignal<CapturedRequest[]>([]);
  const [liveEvents, setLiveEvents] = createSignal<LiveEvent[]>([]);
  const [rawFrames, setRawFrames] = createSignal<RawFrame[]>([]);
  const [sessionMeta, setSessionMeta] = createSignal<any>(null);

  // Filters & controls
  const [eventFilter, setEventFilter] = createSignal<string>("all");
  const [toolSearch, setToolSearch] = createSignal<string>("");
  const [autoScroll, setAutoScroll] = createSignal<boolean>(true);
  const [promptInput, setPromptInput] = createSignal<string>("");
  const [expandedEvents, setExpandedEvents] = createSignal<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = createSignal<Record<string, boolean>>({});
  const [liveThinking, setLiveThinking] = createSignal<string>("");
  const [liveText, setLiveText] = createSignal<string>("");

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

      // Record raw frame
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

      // Handle session debug data response
      if (msg.type === "session_debug_data") {
        if (msg.systemPrompt) setSystemPrompt(msg.systemPrompt);
        if (msg.tools && Array.isArray(msg.tools)) setNativeTools(msg.tools);
        if (msg.session) setSessionMeta(msg.session);
        if (msg.recentPayloads && Array.isArray(msg.recentPayloads)) {
          const recs: CapturedRequest[] = msg.recentPayloads.map((r: any, idx: number) => ({
            id: `payload_${r.turnIndex || 0}_${r.step || 0}_${idx}_${r.timestamp || now}`,
            turnIndex: r.turnIndex ?? 0,
            step: r.step ?? 0,
            endpoint: r.endpoint || "",
            model: r.model || "",
            system: r.system || "",
            reasoning: r.reasoning || "",
            maxTokens: r.maxTokens || 0,
            sessionId: r.sessionId || msg.sessionId || "",
            tools: r.tools || [],
            messages: r.messages || [],
            rawPayload: r.rawPayload,
            timestamp: r.timestamp || now,
          }));
          setCapturedPayloads((prev) => {
            const map = new Map<string, CapturedRequest>();
            for (const item of recs) map.set(`${item.turnIndex}:${item.step}:${item.timestamp}`, item);
            for (const item of prev) map.set(`${item.turnIndex}:${item.step}:${item.timestamp}`, item);
            const combined = Array.from(map.values()).sort((a, b) => b.timestamp - a.timestamp);
            return combined;
          });
          if (recs.length > 0 && !selectedPayloadId()) {
            setSelectedPayloadId(recs[0].id);
          }
        }
      }

      // Handle live agent_events
      if (msg.type === "agent_event" && msg.event) {
        const ev = msg.event;
        const sid = msg.sessionId || "";

        // Track live events
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

        // Live stream deltas
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
          // Update last captured payload with usage/finish
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

        // Captured LLM request right when sent to AI
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
    requestSessionDebug();
  });

  // Auto-select session if none selected
  createEffect(() => {
    const list = sessions();
    if (list.length > 0 && !selectedSessionId()) {
      // Find running or first session
      const running = list.find((s) => s.status === "running");
      setSelectedSessionId((running ?? list[0]).id);
    }
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
    toast("Prompt dispatched", "ok");
  }

  function copyText(val: string, label = "Copied") {
    navigator.clipboard.writeText(val);
    toast(`${label} to clipboard`, "ok");
  }

  function formatJson(val: any): string {
    try {
      if (typeof val === "string") {
        return JSON.stringify(JSON.parse(val), null, 2);
      }
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
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
      <header class="flex items-center justify-between px-4 py-2.5 bg-ink-900 border-b border-line shrink-0 gap-3 z-20">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded bg-brand-500/20 text-brand-400 font-mono font-bold text-xs border border-brand-500/40">
              DEV
            </span>
            <div class="flex flex-col">
              <span class="font-bold text-sm tracking-tight flex items-center gap-1.5 font-mono">
                INDIRECT CODE // DEV MODE
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-mono font-normal">
                  RAW INSPECTOR
                </span>
              </span>
              <span class="text-[11px] text-ink-400 font-mono">
                Full AI Payloads, System Prompt & Native Tools
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
            title="Refresh session debug state from daemon"
          >
            <Icon name={Icons.refresh} size={13} />
            Refresh
          </button>

          <a
            href="#/code"
            class="flex items-center gap-1 px-2.5 py-1 text-xs bg-ink-800 hover:bg-ink-700 text-ink-300 rounded border border-line font-mono transition-colors"
          >
            To Normal UI ↗
          </a>
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
          LLM Payloads & Wire ({capturedPayloads().length})
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
        {/* 1. LLM PAYLOADS TAB */}
        <Show when={activeTab() === "payloads"}>
          <div class="flex-1 min-h-0 flex overflow-hidden">
            {/* Sidebar: Captured requests list */}
            <div class="w-80 border-r border-line bg-ink-900/60 flex flex-col shrink-0">
              <div class="px-3 py-2 border-b border-line flex items-center justify-between text-xs font-mono text-ink-400">
                <span>CAPTURED LLM REQUESTS</span>
                <span>{capturedPayloads().length} total</span>
              </div>

              <div class="flex-1 overflow-y-auto divide-y divide-line/40">
                <Show
                  when={capturedPayloads().length > 0}
                  fallback={
                    <div class="p-6 text-center text-xs font-mono text-ink-500">
                      No LLM payloads captured yet. Send a prompt to see the exact payload sent to AI!
                    </div>
                  }
                >
                  <For each={capturedPayloads()}>
                    {(req) => (
                      <button
                        onClick={() => setSelectedPayloadId(req.id)}
                        class={`w-full text-left p-2.5 transition-colors font-mono cursor-pointer flex flex-col gap-1 ${
                          selectedPayload()?.id === req.id
                            ? "bg-brand-500/15 border-l-2 border-brand-500 text-ink-100"
                            : "hover:bg-ink-800/40 text-ink-300"
                        }`}
                      >
                        <div class="flex items-center justify-between text-[11px]">
                          <span class="font-bold text-brand-400">
                            Turn #{req.turnIndex} / Step #{req.step}
                          </span>
                          <span class="text-[10px] text-ink-500">
                            {new Date(req.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div class="text-[11px] truncate text-ink-200">
                          {req.model || "model"}
                        </div>
                        <div class="flex items-center gap-2 text-[10px] text-ink-400">
                          <span>{req.tools?.length || 0} tools</span>
                          <span>•</span>
                          <span>{req.messages?.length || 0} msgs</span>
                          <Show when={req.reasoning}>
                            <span>•</span>
                            <span class="text-amber-400">{req.reasoning}</span>
                          </Show>
                          <Show when={req.stopReason}>
                            <span>•</span>
                            <span class="text-emerald-400">{req.stopReason}</span>
                          </Show>
                        </div>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </div>

            {/* Main Payload Inspector */}
            <div class="flex-1 min-h-0 flex flex-col bg-ink-950 overflow-hidden">
              <Show
                when={selectedPayload()}
                fallback={
                  <div class="flex-1 flex items-center justify-center text-xs font-mono text-ink-500">
                    Select a captured request from the sidebar
                  </div>
                }
              >
                {(req) => (
                  <div class="flex-1 flex flex-col min-h-0">
                    {/* Payload Header details */}
                    <div class="px-4 py-2 bg-ink-900 border-b border-line flex items-center justify-between shrink-0 font-mono text-xs">
                      <div class="flex items-center gap-3">
                        <span class="font-bold text-brand-400">
                          POST {req().endpoint || "/messages"}
                        </span>
                        <span class="text-ink-400">Model: <strong class="text-ink-200">{req().model}</strong></span>
                        <span class="text-ink-400">Reasoning: <strong class="text-amber-300">{req().reasoning || "default"}</strong></span>
                        <span class="text-ink-400">MaxTokens: <strong class="text-ink-200">{req().maxTokens}</strong></span>
                      </div>
                      <div class="flex items-center gap-2">
                        <button
                          onClick={() => copyText(formatJson(req().rawPayload), "Wire payload JSON")}
                          class="px-2.5 py-1 bg-ink-800 hover:bg-ink-700 text-brand-400 rounded border border-line text-[11px] flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <Icon name={Icons.copy} size={12} />
                          Copy Raw JSON
                        </button>
                      </div>
                    </div>

                    {/* Payload Sub-tabs */}
                    <div class="flex items-center px-4 bg-ink-900/50 border-b border-line shrink-0 gap-1 text-[11px] font-mono">
                      <button
                        onClick={() => setPayloadSubTab("raw")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "raw"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Exact Wire JSON Body
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
                        Messages Array ({req().messages?.length || 0})
                      </button>
                      <button
                        onClick={() => setPayloadSubTab("tools")}
                        class={`px-3 py-1.5 font-medium border-b-2 transition-colors cursor-pointer ${
                          payloadSubTab() === "tools"
                            ? "border-brand-500 text-brand-400"
                            : "border-transparent text-ink-400 hover:text-ink-200"
                        }`}
                      >
                        Tools Provided ({req().tools?.length || 0})
                      </button>
                    </div>

                    {/* Sub-tab view */}
                    <div class="flex-1 min-h-0 overflow-auto p-4 font-mono text-xs">
                      {/* Sub-tab 1: Raw JSON body */}
                      <Show when={payloadSubTab() === "raw"}>
                        <pre class="bg-ink-900 p-4 rounded-lg border border-line text-emerald-300 overflow-x-auto whitespace-pre font-mono text-[12px] leading-relaxed">
                          {formatJson(req().rawPayload)}
                        </pre>
                      </Show>

                      {/* Sub-tab 2: System prompt */}
                      <Show when={payloadSubTab() === "system"}>
                        <div class="flex flex-col gap-2">
                          <div class="flex items-center justify-between text-xs text-ink-400">
                            <span>Chars: {req().system?.length || 0} • Words: {req().system?.split(/\s+/).length || 0} • Est. Tokens: ~{Math.round((req().system?.length || 0) / 4)}</span>
                            <button
                              onClick={() => copyText(req().system, "System prompt")}
                              class="px-2 py-0.5 bg-ink-800 hover:bg-ink-700 text-brand-400 rounded border border-line text-[11px]"
                            >
                              Copy Prompt
                            </button>
                          </div>
                          <pre class="bg-ink-900 p-4 rounded-lg border border-line text-ink-200 overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed select-text">
                            {req().system || "(No system prompt in this request)"}
                          </pre>
                        </div>
                      </Show>

                      {/* Sub-tab 3: Messages array */}
                      <Show when={payloadSubTab() === "messages"}>
                        <div class="flex flex-col gap-3">
                          <For each={req().messages}>
                            {(m: any, idx) => (
                              <div class="border border-line rounded-lg bg-ink-900/60 overflow-hidden">
                                <div class="px-3 py-1.5 bg-ink-900 border-b border-line flex items-center justify-between text-[11px]">
                                  <span class="font-bold flex items-center gap-1.5">
                                    <span class="text-ink-500">#{idx()}</span>
                                    <span
                                      class={`px-1.5 py-0.2 rounded text-[10px] uppercase font-mono ${
                                        m.role === "user"
                                          ? "bg-blue-500/20 text-blue-400"
                                          : m.role === "assistant"
                                            ? "bg-purple-500/20 text-purple-400"
                                            : "bg-amber-500/20 text-amber-400"
                                      }`}
                                    >
                                      {m.role}
                                    </span>
                                  </span>
                                  <span class="text-ink-500 text-[10px]">
                                    {Array.isArray(m.content) ? `${m.content.length} blocks` : "string content"}
                                  </span>
                                </div>
                                <div class="p-3 text-[11px] overflow-x-auto">
                                  <Show when={Array.isArray(m.content)} fallback={<pre class="whitespace-pre-wrap">{String(m.content)}</pre>}>
                                    <div class="flex flex-col gap-2">
                                      <For each={m.content}>
                                        {(block: any) => (
                                          <div class="bg-ink-950 p-2.5 rounded border border-line/60">
                                            <div class="text-[10px] text-ink-400 mb-1 font-bold">
                                              BLOCK TYPE: {block.type || (block.Text ? "text" : "unknown")}
                                            </div>
                                            <pre class="whitespace-pre-wrap text-ink-200">{formatJson(block)}</pre>
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

                      {/* Sub-tab 4: Tools provided */}
                      <Show when={payloadSubTab() === "tools"}>
                        <div class="flex flex-col gap-3">
                          <For each={req().tools}>
                            {(t: any) => (
                              <div class="border border-line rounded-lg bg-ink-900/60 p-3">
                                <div class="flex items-center justify-between mb-1.5">
                                  <span class="font-bold text-brand-400 text-xs font-mono">{t.name || t.Name}</span>
                                  <span class="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-400">
                                    {t.deferred || t.Deferred ? "DEFERRED" : "ACTIVE"}
                                  </span>
                                </div>
                                <p class="text-xs text-ink-300 mb-2">{t.description || t.Description}</p>
                                <div class="text-[10px] text-ink-500 mb-1 font-bold">INPUT SCHEMA:</div>
                                <pre class="bg-ink-950 p-2 rounded border border-line text-[11px] overflow-x-auto text-emerald-300">
                                  {formatJson(t.schema || t.Schema || t.input_schema)}
                                </pre>
                              </div>
                            )}
                          </For>
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
                  class="px-2.5 py-1 bg-ink-800 hover:bg-ink-700 text-rose-400 rounded border border-line text-xs flex items-center gap-1"
                >
                  <Icon name={Icons.trash} size={12} />
                  Clear Stream
                </button>
              </div>
            </div>

            {/* Live Streaming Chains (if model actively reasoning or writing) */}
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
                    No events captured in this session yet. Events will appear here in real time as the turn runs.
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
                            <span class="text-[10px] text-ink-500">
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
                          <div class="flex items-center gap-2">
                            <span class="text-[10px] text-ink-500">
                              {isExpanded() ? "▲ collapse" : "▼ expand"}
                            </span>
                          </div>
                        </div>

                        {/* Collapsible raw details */}
                        <Show when={isExpanded()}>
                          <div class="p-3 bg-ink-950 border-t border-line text-[11px] overflow-x-auto">
                            <pre class="text-emerald-300">{formatJson(ev.data)}</pre>
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
                Showing tools available in Indirect Code daemon
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
                          <div class="flex items-center justify-between mb-1.5 text-[10px] text-ink-400 font-bold">
                            <span>PARAMETER JSON SCHEMA</span>
                            <button
                              onClick={() => copyText(formatJson(t.schema), `${t.name} schema`)}
                              class="text-brand-400 hover:underline cursor-pointer"
                            >
                              Copy Schema
                            </button>
                          </div>
                          <pre class="p-2.5 bg-ink-900 rounded border border-line text-emerald-300 text-[11px] overflow-x-auto">
                            {formatJson(t.schema)}
                          </pre>
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
                class="px-2 py-0.5 bg-ink-800 hover:bg-ink-700 text-rose-400 rounded border border-line text-xs"
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
                        <span class="text-ink-500">
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
                    <pre class="p-2 bg-ink-950 rounded border border-line/60 text-ink-300 text-[11px] overflow-x-auto max-h-48">
                      {formatJson(f.payload)}
                    </pre>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>

      {/* ===== BOTTOM BAR / QUICK PROMPT SENDER ===== */}
      <footer class="px-4 py-2 bg-ink-900 border-t border-line shrink-0 flex items-center gap-3 font-mono text-xs">
        <span class="text-ink-400 shrink-0">Quick Prompt Test:</span>
        <input
          type="text"
          placeholder="Send prompt to selected session..."
          value={promptInput()}
          onInput={(e) => setPromptInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendQuickPrompt();
            }
          }}
          class="flex-1 bg-ink-950 border border-line rounded px-3 py-1.5 text-xs text-ink-100 placeholder-ink-600 focus:outline-none focus:border-brand-500"
        />
        <button
          onClick={sendQuickPrompt}
          disabled={!promptInput().trim() || !selectedSessionId()}
          class="px-4 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-ink-950 font-bold rounded text-xs transition-colors cursor-pointer shrink-0"
        >
          Send
        </button>
      </footer>
    </div>
  );
}
