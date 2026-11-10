import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Icon, Kbd, Segmented } from "../../ui";
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
    return (
      (s.options?.mode || "").toLowerCase() === "talk" ||
      !s.cwd ||
      s.cwd.toLowerCase().includes("/talk")
    );
  };

  const isCwdMatch = (s: SessionSummary) => {
    if (props.matchedByCwd) return props.matchedByCwd(s);
    const q = props.sessionFilter().toLowerCase().trim();
    if (!q || !s.cwd) return false;
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
      <div class="max-w-2xl mx-auto space-y-5">
        {/* Command-Palette Header */}
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-sm sm:text-base font-medium text-fg truncate">
              Conversation History
            </h2>
            <p class="mt-0.5 text-xs text-fg-muted">
              {props.sessions().length} stored{" "}
              {props.sessions().length === 1 ? "conversation" : "conversations"} · instant host search
            </p>
          </div>
          <button
            type="button"
            onClick={() => props.setHistoryView(false)}
            class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer shrink-0"
            data-rc-tip="Back to chat"
            aria-label="Back to chat"
          >
            <span>Close</span>
            <Kbd>Esc</Kbd>
          </button>
        </div>

        {/* Unified Command-Palette Search & Filter Frame */}
        <div class="rounded-panel border border-border-strong/80 bg-surface overflow-hidden focus-within:border-fg transition-colors">
          <div class="flex items-center gap-2.5 px-3.5 py-2.5">
            <Iconify icon="lucide:search" size={15} class="shrink-0 text-fg-muted" />
            <input
              type="text"
              placeholder={
                props.isMobile()
                  ? "Search conversations, folders, or messages…"
                  : "Search conversations, folders, or messages… (Ctrl+K)"
              }
              class="min-w-0 flex-1 bg-transparent text-[13px] text-fg placeholder:text-fg-muted focus:outline-none"
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
            <Show
              when={props.sessionFilter().length > 0}
              fallback={
                <Show when={!props.isMobile()}>
                  <Kbd>Esc</Kbd>
                </Show>
              }
            >
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

          <div class="flex items-center justify-between gap-2 border-t border-border bg-surface-subtle/70 px-2.5 py-1.5 flex-wrap">
            <Segmented
              value={activeTab()}
              onChange={setActiveTab}
              options={FILTER_OPTIONS}
            />
            <span class="px-1.5 font-mono text-[11px] text-fg-muted tabular-nums">
              {filteredSessions().length}{" "}
              {filteredSessions().length === 1 ? "session" : "sessions"}
              <Show when={filteredSearchResults().length > 0}>
                <span> · {filteredSearchResults().length} hits</span>
              </Show>
            </span>
          </div>
        </div>

        <Show
          when={hasAnyResults()}
          fallback={
            <div class="flex flex-col items-center justify-center border-y border-border/70 py-14 px-4 text-center">
              <div class="mb-2.5 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-fg-muted">
                <Icon name="lucide:search-x" size={18} class="text-fg-muted" />
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
                <p class="mt-1 text-xs text-fg-muted">
                  Try another search term or switch filter tabs.
                </p>
              </Show>
            </div>
          }
        >
          <div class="space-y-5">
            {/* Daemon full-text hits (message content, host-local) */}
            <Show when={filteredSearchResults().length > 0}>
              <div>
                <div class="flex items-center justify-between pb-1.5 px-1 text-[11px] font-medium text-fg-muted">
                  <span>Message matches</span>
                  <span class="font-mono tabular-nums">{filteredSearchResults().length}</span>
                </div>
                <div class="divide-y divide-border/70 border-y border-border/70">
                  <For each={filteredSearchResults()}>
                    {(r) => (
                      <button
                        type="button"
                        onClick={() => {
                          props.setHistoryView(false);
                          props.setSearchResults([]);
                          props.selectSession(r.sessionId, r.messageIdx);
                        }}
                        class="w-full px-2.5 py-2.5 text-left hover:bg-surface-subtle transition-colors cursor-pointer group"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex items-center gap-2 min-w-0">
                            <Iconify
                              icon="lucide:message-square-text"
                              size={13}
                              class="shrink-0 text-fg-muted group-hover:text-accent transition-colors"
                            />
                            <span class="truncate text-[13px] font-medium text-fg group-hover:text-accent transition-colors">
                              {highlightMatch(r.title, props.sessionFilter())}
                            </span>
                          </div>
                          <span class="shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
                            {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}
                            {timeAgo(r.updatedAt)}
                          </span>
                        </div>
                        <p class="mt-1 pl-5 text-xs text-fg-secondary line-clamp-2 leading-relaxed">
                          {highlightMatch(r.snippet, props.sessionFilter())}
                        </p>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* Session Rows */}
            <Show when={filteredSessions().length > 0}>
              <div>
                <div class="flex items-center justify-between pb-1.5 px-1 text-[11px] font-medium text-fg-muted">
                  <span>Conversations</span>
                  <span class="font-mono tabular-nums">{filteredSessions().length}</span>
                </div>
                <div class="divide-y divide-border/70 border-y border-border/70">
                  <For each={filteredSessions()}>
                    {(s) => (
                      <button
                        type="button"
                        onClick={() => {
                          props.setHistoryView(false);
                          props.selectSession(s.id);
                        }}
                        class="w-full px-2.5 py-2.5 text-left hover:bg-surface-subtle transition-colors group cursor-pointer"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="flex items-center gap-2 min-w-0">
                            <Show
                              when={s.pinned}
                              fallback={
                                <Iconify
                                  icon="lucide:message-square"
                                  size={13}
                                  class="shrink-0 text-fg-muted group-hover:text-fg-secondary transition-colors"
                                />
                              }
                            >
                              <Iconify icon="lucide:pin" size={12} class="shrink-0 text-accent" />
                            </Show>
                            <span class="truncate text-[13px] font-medium text-fg">
                              {highlightMatch(s.title, props.sessionFilter())}
                            </span>
                          </div>
                          <span class="shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
                            {timeAgo(sessionTimeLabel(s))}
                          </span>
                        </div>
                        <Show
                          when={s.cwd}
                          fallback={
                            <div class="mt-1 flex items-center gap-1.5 pl-5 text-[11px] text-fg-muted">
                              <Iconify icon="lucide:messages-square" size={11} class="shrink-0" />
                              <span>Talk</span>
                            </div>
                          }
                        >
                          <div class="mt-1 flex items-center gap-1.5 pl-5 text-[11px] text-fg-muted">
                            <Iconify icon="lucide:folder" size={11} class="shrink-0" />
                            <span class="truncate font-mono">
                              {highlightMatch(s.cwd, props.sessionFilter())}
                            </span>
                          </div>
                        </Show>
                        <Show when={isCwdMatch(s)}>
                          <div class="mt-1.5 pl-5">
                            <span class="inline-flex items-center gap-1 rounded border border-accent/25 bg-accent-subtle px-2 py-0.5 text-[10px] font-medium text-fg">
                              Matched project folder:{" "}
                              <span class="font-mono text-fg-secondary">
                                {highlightMatch(s.cwd, props.sessionFilter())}
                              </span>
                            </span>
                          </div>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
