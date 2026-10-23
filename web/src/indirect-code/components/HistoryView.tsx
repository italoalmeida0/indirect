import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Icon, Segmented } from "../../ui";
import { timeAgo } from "../utils/format";
import { sessionTimeLabel } from "../paths";
import type { SessionSummary } from "../types";
import type { SearchHit } from "../viewTypes";

export type HistoryTab = "all" | "pinned" | "recent" | "talk";

const FILTER_OPTIONS: Array<{ value: HistoryTab; label: string }> = [
  { value: "all", label: "All" },
  { value: "pinned", label: "Pinned" },
  { value: "recent", label: "Recent" },
  { value: "talk", label: "Talk" },
];

/** Highlight matching substrings in search results. */
export function highlightMatch(text: string, query: string): JSX.Element {
  if (!text) return "";
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  if (parts.length <= 1) return text;
  return (
    <For each={parts}>
      {(part) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark class="bg-accent-500/30 text-ink-100 rounded px-0.5 font-medium">{part}</mark>
        ) : (
          part
        )
      }
    </For>
  );
}

/** Conversation history view (extracted from TranscriptView without
 * visual changes — narrow props instead of the god-ctx). */
export interface HistoryViewProps {
  sessionFilter: () => string;
  setSessionFilter: (v: string) => void;
  queueDaemonSearch: (q: string) => void;
  searchResults: () => SearchHit[];
  setSearchResults: (v: SearchHit[]) => void;
  setHistoryView: (v: boolean) => void;
  selectSession: (id: string, messageIdx?: number) => void;
  sessions: () => SessionSummary[];
  matchQuery: (s: SessionSummary) => boolean;
  sortedSessions: (list: SessionSummary[]) => SessionSummary[];
  isMobile: () => boolean;
  matchedByCwd?: (s: SessionSummary) => boolean;
}

export function HistoryView(props: HistoryViewProps) {
  const [activeTab, setActiveTab] = createSignal<HistoryTab>("all");

  const isTalk = (s: SessionSummary) => {
    return (s.options?.mode || "").toLowerCase() === "talk" || s.cwd.toLowerCase().includes("/talk");
  };

  const isCwdMatch = (s: SessionSummary) => {
    if (props.matchedByCwd) return props.matchedByCwd(s);
    const q = props.sessionFilter().toLowerCase().trim();
    if (!q) return false;
    return !s.title.toLowerCase().includes(q) && s.cwd.toLowerCase().includes(q);
  };

  const filteredSessions = createMemo(() => {
    const list = props.sessions().filter(props.matchQuery);
    const tab = activeTab();
    if (tab === "pinned") {
      return props.sortedSessions(list.filter((s) => s.pinned));
    }
    if (tab === "talk") {
      return props.sortedSessions(list.filter(isTalk));
    }
    if (tab === "recent") {
      return [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return props.sortedSessions(list);
  });

  const sessionMap = createMemo(() => new Map(props.sessions().map((s) => [s.id, s])));

  const filteredSearchResults = createMemo(() => {
    const raw = props.searchResults();
    const tab = activeTab();
    if (tab === "pinned") {
      return raw.filter((r) => sessionMap().get(r.sessionId)?.pinned);
    }
    if (tab === "talk") {
      return raw.filter((r) => {
        const s = sessionMap().get(r.sessionId);
        return s ? isTalk(s) : false;
      });
    }
    if (tab === "recent") {
      return [...raw].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    }
    return raw;
  });

  const hasAnyResults = () => filteredSearchResults().length > 0 || filteredSessions().length > 0;

  return (
    <div class="flex-1 overflow-y-auto px-4 md:px-8 py-8">
      <div class="max-w-2xl mx-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-base font-semibold text-ink-100">Conversation History</h2>
          <button
            onClick={() => props.setHistoryView(false)}
            class="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
            data-rc-tip="Back to chat"
            aria-label="Back to chat"
          >
            <Iconify icon="lucide:x" size={15} />
          </button>
        </div>
        <div class="relative mb-3">
          <Iconify icon="lucide:search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
          <input
            type="text"
            placeholder={
              props.isMobile()
                ? "Search conversations and messages..."
                : "Search conversations and messages... (Ctrl+K)"
            }
            class="w-full text-[13px] bg-ink-900 border border-line/70 rounded-xl pl-9 pr-3 py-2 text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            value={props.sessionFilter()}
            onInput={(e) => {
              props.setSessionFilter(e.currentTarget.value);
              props.queueDaemonSearch(e.currentTarget.value);
            }}
            ref={(el) => setTimeout(() => el?.focus(), 50)}
          />
        </div>

        {/* Filter tabs */}
        <div class="mb-4">
          <Segmented
            value={activeTab()}
            onChange={setActiveTab}
            options={FILTER_OPTIONS}
          />
        </div>

        <Show
          when={hasAnyResults()}
          fallback={
            <div class="flex flex-col items-center justify-center py-12 text-center">
              <Icon name="lucide:search-x" size={40} class="w-10 h-10 text-ink-500 mb-2" />
              <p class="text-sm font-medium text-ink-300">
                {props.sessionFilter().trim()
                  ? `No conversations or messages match '${props.sessionFilter().trim()}'`
                  : activeTab() === "pinned"
                    ? "No pinned conversations."
                    : activeTab() === "talk"
                      ? "No talk conversations."
                      : "No conversations found."}
              </p>
              <Show when={props.sessionFilter().trim()}>
                <p class="text-xs text-ink-500 mt-1">Try another search term or switch filter tabs</p>
              </Show>
            </div>
          }
        >
          {/* Daemon full-text hits (message content, host-local) */}
          <Show when={filteredSearchResults().length > 0}>
            <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
              Message matches
            </div>
            <div class="space-y-1 mb-4">
              <For each={filteredSearchResults()}>
                {(r) => (
                  <button
                    onClick={() => {
                      props.setHistoryView(false);
                      props.setSearchResults([]);
                      props.selectSession(r.sessionId, r.messageIdx);
                    }}
                    class="w-full text-left px-3 py-2.5 rounded-xl border border-line/50 hover:bg-ink-900/70 transition-colors cursor-pointer"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-[13px] text-ink-200 truncate font-medium">
                        {highlightMatch(r.title, props.sessionFilter())}
                      </span>
                      <span class="text-[11px] text-ink-600 shrink-0">
                        {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}{timeAgo(r.updatedAt)}
                      </span>
                    </div>
                    <p class="text-[11px] text-ink-500 mt-1 line-clamp-2 leading-relaxed">
                      {highlightMatch(r.snippet, props.sessionFilter())}
                    </p>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={filteredSessions().length > 0}>
            <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
              Conversations
            </div>
            <div class="space-y-1">
              <For each={filteredSessions()}>
                {(s) => (
                  <button
                    onClick={() => {
                      props.setHistoryView(false);
                      props.selectSession(s.id);
                    }}
                    class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-ink-900/70 transition-colors group cursor-pointer"
                  >
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-1.5 truncate">
                        <Show when={s.pinned}>
                          <Iconify icon="lucide:pin" size={11} class="text-ink-400 shrink-0" />
                        </Show>
                        <span class="text-[13px] text-ink-200 truncate font-medium">
                          {highlightMatch(s.title, props.sessionFilter())}
                        </span>
                      </div>
                      <span class="text-[11px] text-ink-600 shrink-0">{timeAgo(sessionTimeLabel(s))}</span>
                    </div>
                    <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-ink-500">
                      <Iconify icon="lucide:folder" size={11} />
                      <span class="truncate font-mono">{highlightMatch(s.cwd, props.sessionFilter())}</span>
                    </div>
                    <Show when={isCwdMatch(s)}>
                      <div class="mt-1">
                        <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-ink-800 text-ink-400 border border-line/40">
                          Matched project folder: <span class="font-mono text-ink-300">{highlightMatch(s.cwd, props.sessionFilter())}</span>
                        </span>
                      </div>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
