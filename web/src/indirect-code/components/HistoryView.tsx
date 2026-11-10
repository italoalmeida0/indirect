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
    <div class="flex-1 overflow-y-auto px-4 md:px-8 py-6 sm:py-8">
      <div class="max-w-2xl mx-auto space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-subtle text-accent">
              <Iconify icon="lucide:history" size={16} />
            </div>
            <div class="min-w-0">
              <h2 class="text-base font-medium text-fg truncate">Conversation History</h2>
              <p class="text-[11px] text-fg-muted">
                {props.sessions().length} stored {props.sessions().length === 1 ? "conversation" : "conversations"} · instant full-text host search
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => props.setHistoryView(false)}
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-control border border-border bg-surface text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-muted transition-colors cursor-pointer shrink-0"
            data-rc-tip="Back to chat"
            aria-label="Back to chat"
          >
            <Iconify icon="lucide:x" size={14} />
            <span class="hidden sm:inline">Close</span>
          </button>
        </div>

        {/* Search Input Studio Bar */}
        <div class="rc-studio-well flex items-center gap-2.5 px-3 py-2 focus-within:border-accent transition-colors">
          <Iconify icon="lucide:search" size={15} class="shrink-0 text-accent" />
          <input
            type="text"
            placeholder={
              props.isMobile()
                ? "Search conversations and messages..."
                : "Search conversations and messages... (Ctrl+K)"
            }
            class="flex-1 min-w-0 text-[13px] bg-transparent text-fg placeholder:text-fg-muted focus:outline-none"
            value={props.sessionFilter()}
            onInput={(e) => {
              props.setSessionFilter(e.currentTarget.value);
              props.queueDaemonSearch(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (props.sessionFilter()) {
                  props.setSessionFilter("");
                  props.setSearchResults([]);
                } else {
                  props.setHistoryView(false);
                }
              }
            }}
            ref={(el) => setTimeout(() => el?.focus(), 50)}
          />
          <Show when={props.sessionFilter().length > 0}>
            <button
              type="button"
              onClick={() => {
                props.setSessionFilter("");
                props.setSearchResults([]);
              }}
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-muted hover:text-fg cursor-pointer"
              aria-label="Clear search"
            >
              <Iconify icon="lucide:x" size={12} />
            </button>
          </Show>
        </div>

        {/* Filter tabs */}
        <div>
          <Segmented
            value={activeTab()}
            onChange={setActiveTab}
            options={FILTER_OPTIONS}
          />
        </div>

        <Show
          when={hasAnyResults()}
          fallback={
            <div class="rc-studio-card flex flex-col items-center justify-center py-12 px-4 text-center">
              <div class="flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface text-fg-muted mb-3">
                <Icon name="lucide:search-x" size={24} class="w-6 h-6 text-fg-muted" />
              </div>
              <p class="text-sm font-medium text-fg">
                {props.sessionFilter().trim()
                  ? `No conversations or messages match '${props.sessionFilter().trim()}'`
                  : activeTab() === "pinned"
                    ? "No pinned conversations."
                    : activeTab() === "talk"
                      ? "No talk conversations."
                      : "No conversations found."}
              </p>
              <Show when={props.sessionFilter().trim()}>
                <p class="text-xs text-fg-muted mt-1">Try another search term or switch filter tabs</p>
              </Show>
            </div>
          }
        >
          {/* Daemon full-text hits (message content, host-local) */}
          <Show when={filteredSearchResults().length > 0}>
            <div class="space-y-1.5">
              <div class="px-1 flex items-center justify-between text-[11px] font-medium text-fg-muted">
                <span>Message matches</span>
                <span class="font-mono">{filteredSearchResults().length}</span>
              </div>
              <div class="space-y-1.5">
                <For each={filteredSearchResults()}>
                  {(r) => (
                    <button
                      type="button"
                      onClick={() => {
                        props.setHistoryView(false);
                        props.setSearchResults([]);
                        props.selectSession(r.sessionId, r.messageIdx);
                      }}
                      class="w-full text-left px-3.5 py-3 rounded-panel border border-border bg-surface hover:bg-surface-subtle hover:border-border-strong shadow-resting transition-all cursor-pointer group"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <span class="text-[13px] text-fg truncate font-medium group-hover:text-accent transition-colors">
                          {highlightMatch(r.title, props.sessionFilter())}
                        </span>
                        <span class="text-[11px] text-fg-muted font-mono shrink-0">
                          {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}{timeAgo(r.updatedAt)}
                        </span>
                      </div>
                      <p class="text-xs text-fg-secondary mt-1 line-clamp-2 leading-relaxed">
                        {highlightMatch(r.snippet, props.sessionFilter())}
                      </p>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={filteredSessions().length > 0}>
            <div class="space-y-1.5">
              <div class="px-1 flex items-center justify-between text-[11px] font-medium text-fg-muted">
                <span>Conversations</span>
                <span class="font-mono">{filteredSessions().length}</span>
              </div>
              <div class="space-y-1.5">
                <For each={filteredSessions()}>
                  {(s) => (
                    <button
                      type="button"
                      onClick={() => {
                        props.setHistoryView(false);
                        props.selectSession(s.id);
                      }}
                      class="w-full text-left px-3.5 py-2.5 rounded-panel border border-border/80 bg-surface-subtle hover:bg-surface hover:border-border-strong transition-all group cursor-pointer"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <Show when={s.pinned}>
                            <Iconify icon="lucide:pin" size={11} class="text-accent shrink-0" />
                          </Show>
                          <span class="text-[13px] text-fg truncate font-medium">
                            {highlightMatch(s.title, props.sessionFilter())}
                          </span>
                        </div>
                        <span class="text-[11px] text-fg-muted font-mono shrink-0">{timeAgo(sessionTimeLabel(s))}</span>
                      </div>
                      <div class="flex items-center gap-1.5 mt-1 text-[11px] text-fg-muted">
                        <Iconify icon="lucide:folder" size={11} class="shrink-0" />
                        <span class="truncate font-mono">{highlightMatch(s.cwd, props.sessionFilter())}</span>
                      </div>
                      <Show when={isCwdMatch(s)}>
                        <div class="mt-1.5">
                          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-accent-subtle text-fg border border-accent/25">
                            Matched project folder: <span class="font-mono text-fg-secondary">{highlightMatch(s.cwd, props.sessionFilter())}</span>
                          </span>
                        </div>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
