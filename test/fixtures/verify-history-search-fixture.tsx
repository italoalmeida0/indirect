import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { HistoryView } from "../../web/src/indirect-code/components/HistoryView";
import type { SessionSummary } from "../../web/src/indirect-code/types";
import type { SearchHit } from "../../web/src/indirect-code/viewTypes";

const sampleSessions: SessionSummary[] = [
  {
    id: "sess-1",
    title: "User Authentication Bug",
    cwd: "/home/user/workspace/web-app",
    pinned: true,
    updatedAt: 1000,
    hostId: "h1",
    model: "test-model",
    status: "idle",
    createdAt: 1000,
    options: { mode: "build", effort: "high", skills: [], access: "full" },
  },
  {
    id: "sess-2",
    title: "Payment Gateway Refactor",
    cwd: "/home/user/workspace/billing-api",
    pinned: false,
    updatedAt: 4000,
    hostId: "h1",
    model: "test-model",
    status: "idle",
    createdAt: 1000,
    options: { mode: "build", effort: "high", skills: [], access: "full" },
  },
  {
    id: "sess-3",
    title: "Support Onboarding Chat",
    cwd: "/home/user/workspace/talk",
    pinned: false,
    updatedAt: 2000,
    hostId: "h1",
    model: "test-model",
    status: "idle",
    createdAt: 1000,
    options: { mode: "talk", effort: "high", skills: [], access: "full" },
  },
  {
    id: "sess-4",
    title: "Database Indexing Script",
    cwd: "/home/user/workspace/infra-auth-db",
    pinned: false,
    updatedAt: 3000,
    hostId: "h1",
    model: "test-model",
    status: "idle",
    createdAt: 1000,
    options: { mode: "build", effort: "high", skills: [], access: "full" },
  },
];

const sampleMessageHits: SearchHit[] = [
  {
    sessionId: "sess-2",
    title: "Payment Gateway Refactor",
    snippet: "Fixed token auth header verification inside payment webhook endpoint",
    cwd: "/home/user/workspace/billing-api",
    matchCount: 2,
    messageIdx: 5,
    updatedAt: 4000,
  },
];

function HistoryFixture() {
  const [sessions, setSessions] = createSignal<SessionSummary[]>(sampleSessions);
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  const [searchResults, setSearchResults] = createSignal<SearchHit[]>([]);
  const [historyView, setHistoryViewSignal] = createSignal<boolean>(false);
  const [activeSessionId, setActiveSessionId] = createSignal<string>("sess-1");
  const [lastScrolledMessageIdx, setLastScrolledMessageIdx] = createSignal<number | null>(null);
  const [selectSessionCalls, setSelectSessionCalls] = createSignal<Array<{ id: string; messageIdx?: number }>>([]);

  let previousActiveElement: HTMLElement | null = null;

  function setHistoryView(v: boolean | ((p: boolean) => boolean)) {
    const next = typeof v === "function" ? v(historyView()) : v;
    if (next && !historyView()) {
      if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        previousActiveElement = document.activeElement;
      }
    } else if (!next && historyView()) {
      const el = previousActiveElement;
      previousActiveElement = null;
      queueMicrotask(() => {
        if (el && document.contains(el)) {
          el.focus();
        } else {
          const composer = document.querySelector<HTMLElement>('textarea[aria-label="Prompt"], textarea, input[type="text"]');
          composer?.focus();
        }
      });
    }
    setHistoryViewSignal(next);
  }

  function queueDaemonSearch(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const hits = sampleMessageHits.filter(
      (h) => h.snippet.toLowerCase().includes(q) || h.title.toLowerCase().includes(q)
    );
    setSearchResults(hits);
  }

  function matchQuery(s: SessionSummary): boolean {
    const q = sessionFilter().trim().toLowerCase();
    if (!q) return true;
    return s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q);
  }

  function matchedByCwd(s: SessionSummary): boolean {
    const q = sessionFilter().trim().toLowerCase();
    if (!q) return false;
    return !s.title.toLowerCase().includes(q) && s.cwd.toLowerCase().includes(q);
  }

  function sortedSessions(list: SessionSummary[]): SessionSummary[] {
    return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  function scrollToMessage(msgIdx: number) {
    setLastScrolledMessageIdx(msgIdx);
    const el = document.getElementById(`message-turn-${msgIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function selectSession(id: string, messageIdx?: number) {
    setSelectSessionCalls((prev) => [...prev, { id, messageIdx }]);
    setActiveSessionId(id);
    if (typeof messageIdx === "number") {
      setTimeout(() => scrollToMessage(messageIdx), 50);
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        setHistoryView((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  (window as any).historyTestApi = {
    sessions,
    setSessions,
    sessionFilter,
    setSessionFilter,
    searchResults,
    setSearchResults,
    historyView,
    setHistoryView,
    activeSessionId,
    setActiveSessionId,
    lastScrolledMessageIdx,
    selectSessionCalls,
    sampleMessageHits,
    queueDaemonSearch,
  };

  return (
    <div class="h-screen flex flex-col bg-ink-950 text-ink-100 font-sans">
      <header class="p-4 border-b border-line flex items-center justify-between">
        <div class="flex items-center gap-3">
          <input
            id="before-ctrl-k-input"
            type="text"
            placeholder="Search or prompt before Ctrl+K..."
            class="px-3 py-1.5 rounded-lg bg-ink-900 border border-line text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <button
            id="open-history-btn"
            onClick={() => setHistoryView(true)}
            class="px-3 py-1.5 rounded-lg bg-ink-800 text-sm hover:bg-ink-700 cursor-pointer"
          >
            Open History
          </button>
        </div>
        <div class="text-xs text-ink-400">
          Active: <span id="active-session-label">{activeSessionId()}</span> |
          Scrolled turn: <span id="scrolled-turn-label">{String(lastScrolledMessageIdx())}</span>
        </div>
      </header>

      <main class="flex-1 flex overflow-hidden">
        <Show
          when={historyView()}
          fallback={
            <div id="transcript-area" class="flex-1 p-6 overflow-y-auto space-y-4">
              <h2 class="text-lg font-bold">Transcript: {activeSessionId()}</h2>
              <div class="space-y-3" style="min-height: 2000px;">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((idx) => (
                  <div
                    id={`message-turn-${idx}`}
                    class={`p-4 rounded-xl border ${
                      lastScrolledMessageIdx() === idx
                        ? "border-amber-400 bg-amber-500/10 ring-2 ring-amber-400"
                        : "border-line bg-ink-900/60"
                    }`}
                    style="margin-bottom: 80px;"
                  >
                    <div class="font-bold text-sm">Turn #{idx}</div>
                    <p class="text-xs text-ink-300">
                      {idx === 5
                        ? "Fixed token auth header verification inside payment webhook endpoint"
                        : `Turn content message index ${idx}`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          }
        >
          <HistoryView
            sessionFilter={sessionFilter}
            setSessionFilter={setSessionFilter}
            queueDaemonSearch={queueDaemonSearch}
            searchResults={searchResults}
            setSearchResults={setSearchResults}
            setHistoryView={setHistoryView}
            selectSession={selectSession}
            sessions={sessions}
            matchQuery={matchQuery}
            sortedSessions={sortedSessions}
            isMobile={() => false}
            matchedByCwd={matchedByCwd}
          />
        </Show>
      </main>
    </div>
  );
}

render(() => <HistoryFixture />, document.getElementById("root")!);
