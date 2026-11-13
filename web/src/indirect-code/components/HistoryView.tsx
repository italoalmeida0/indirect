import { createMemo, createSignal, For, Show, useContext, type JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { Icon, Kbd, Segmented } from "../../ui";
import { SessionCtx, UICtx } from "../ctx";
import { timeAgo } from "../utils/format";
import { sessionTimeLabel } from "../paths";
import type { SessionSummary } from "../types";
import type { SearchHit } from "../viewTypes";
import { RadialSpokeSpinner, UnreadDot } from "./LiveIndicators";

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
          <mark class="bg-accent-subtle text-fg rounded-xs px-0.5 font-medium">{part}</mark>
        ) : (
          part
        )
      }
    </For>
  );
}

/** Conversation history view (narrow props so standalone tests can mount without provider). */
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
  isSessionUnread?: (s: SessionSummary) => boolean;
  sessionAttentionLabel?: (s: SessionSummary) => string;
  activeSessionId?: () => string;
  sessionStatus?: () => string;
}

export function HistoryView(props: HistoryViewProps) {
  const ui = useContext(UICtx);
  const sessionCtx = useContext(SessionCtx);
  const [activeTab, setActiveTab] = createSignal<HistoryTab>("all");

  const isTalk = (s: SessionSummary) => {
    if (sessionCtx?.isTalkSession) return sessionCtx.isTalkSession(s);
    return (s.options?.mode || "").toLowerCase() === "talk";
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
  const widthClass = () => ui?.convWidthClass?.() ?? "max-w-3xl";

  return (
    <div class="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-7">
      <div class={`${widthClass()} w-full mx-auto space-y-4`}>
        {/* Compact utility bar (title lives in WorkspaceHeader above) */}
        <div class="flex items-center justify-between gap-3">
          <p class="min-w-0 truncate text-xs text-fg-muted tabular-nums">
            {props.sessions().length} stored{" "}
            {props.sessions().length === 1 ? "conversation" : "conversations"}
          </p>
          <button
            type="button"
            onClick={() => props.setHistoryView(false)}
            class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer shrink-0"
            data-rc-tip="Back to chat"
            aria-label="Back to chat"
          >
            <span>Back to chat</span>
            <Show when={!props.isMobile()}>
              <Kbd>Esc</Kbd>
            </Show>
          </button>
        </div>

        {/* Unified search & filter card */}
        <div class="rounded-panel border border-border-strong bg-surface overflow-hidden focus-within:border-accent transition-colors">
          <div class="flex items-center gap-2.5 px-3.5 py-2.5">
            <Iconify icon="lucide:search" size={15} class="shrink-0 text-fg-muted" />
            <input
              type="text"
              aria-label="Search conversation history"
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
                    props.queueDaemonSearch("");
                    props.setSearchResults([]);
                  } else {
                    props.setHistoryView(false);
                  }
                }
              }}
              ref={(el) => {
                if (!props.isMobile()) {
                  setTimeout(() => el?.focus(), 50);
                }
              }}
            />
            <Show when={props.sessionFilter().length > 0}>
              <button
                type="button"
                onClick={() => {
                  props.setSessionFilter("");
                  props.queueDaemonSearch("");
                  props.setSearchResults([]);
                }}
                class="ui-icon-button ui-icon-button-xs shrink-0 rounded-lg"
                data-rc-tip="Clear search"
                aria-label="Clear search"
              >
                <Iconify icon="lucide:x" size={13} />
              </button>
            </Show>
          </div>

          <div class="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-subtle px-3.5 py-2 flex-wrap">
            <Segmented
              value={activeTab()}
              onChange={setActiveTab}
              options={FILTER_OPTIONS}
              class="ui-segmented-sm rounded-lg"
              ariaLabel="Filter conversations"
            />
            <span class="text-2xs text-fg-muted tabular-nums">
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
            <div class="flex flex-col items-center justify-center rounded-panel border border-border bg-surface py-12 px-4 text-center">
              <Icon name="lucide:search-x" size={20} class="mb-2.5 text-fg-muted" />
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
          <div class="space-y-4">
            {/* Daemon full-text hits (message content, host-local) */}
            <Show when={filteredSearchResults().length > 0}>
              <div>
                <div class="flex items-center justify-between pb-1.5 px-1 text-2xs font-medium text-fg-muted">
                  <span>Message matches</span>
                  <span class="tabular-nums">{filteredSearchResults().length}</span>
                </div>
                <div class="rounded-panel border border-border bg-surface overflow-hidden divide-y divide-border-subtle">
                  <For each={filteredSearchResults()}>
                    {(r) => {
                      const hitSession = () => sessionMap().get(r.sessionId);
                      const unread = () => {
                        const s = hitSession();
                        return s ? Boolean(props.isSessionUnread?.(s)) : false;
                      };
                      const running = () => {
                        const s = hitSession();
                        return Boolean(
                          s &&
                            (s.status === "running" ||
                              (Boolean(props.activeSessionId?.()) &&
                                props.activeSessionId?.() === s.id &&
                                props.sessionStatus?.() === "running")),
                        );
                      };
                      return (
                        <button
                          type="button"
                          data-history-hit-id={r.sessionId}
                          onClick={() => {
                            props.setHistoryView(false);
                            props.setSearchResults([]);
                            props.selectSession(r.sessionId, r.messageIdx);
                          }}
                          class="w-full px-3.5 py-2.5 text-left hover:bg-surface-subtle transition-colors cursor-pointer group"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div class="flex items-center gap-2 min-w-0">
                              <span class="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                                <Iconify
                                  icon="lucide:message-square-text"
                                  size={13}
                                  class="text-fg-muted group-hover:text-accent transition-colors"
                                />
                              </span>
                              <span
                                class={`truncate text-[13px] ${
                                  unread() ? "font-medium text-fg" : "text-fg-secondary"
                                } group-hover:text-fg transition-colors`}
                              >
                                {highlightMatch(r.title, props.sessionFilter())}
                              </span>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                              <Show
                                when={unread()}
                                fallback={
                                  <Show when={running()}>
                                    <RadialSpokeSpinner size={13} class="text-fg-secondary" />
                                  </Show>
                                }
                              >
                                <UnreadDot
                                  label={
                                    hitSession() && props.sessionAttentionLabel
                                      ? props.sessionAttentionLabel(hitSession()!)
                                      : "Unread update"
                                  }
                                />
                              </Show>
                              <Show when={r.field}>
                                <span class="rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 font-mono text-2xs font-normal text-fg-muted">
                                  {r.field}
                                </span>
                              </Show>
                              <span class="text-2xs text-fg-muted tabular-nums">
                                {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}
                                {timeAgo(r.updatedAt)}
                              </span>
                            </div>
                          </div>
                          <p class="mt-1 pl-6 text-xs text-fg-secondary line-clamp-2 leading-relaxed">
                            {highlightMatch(r.snippet, props.sessionFilter())}
                          </p>
                        </button>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* Session Rows */}
            <Show when={filteredSessions().length > 0}>
              <div>
                <div class="flex items-center justify-between pb-1.5 px-1 text-2xs font-medium text-fg-muted">
                  <span>
                    {props.sessionFilter().trim() ? "Matching conversations" : "Conversations"}
                  </span>
                  <span class="tabular-nums">{filteredSessions().length}</span>
                </div>
                <div class="rounded-panel border border-border bg-surface overflow-hidden divide-y divide-border-subtle">
                  <For each={filteredSessions()}>
                    {(s) => {
                      const unread = () => Boolean(props.isSessionUnread?.(s));
                      const running = () =>
                        s.status === "running" ||
                        (Boolean(props.activeSessionId?.()) &&
                          props.activeSessionId?.() === s.id &&
                          props.sessionStatus?.() === "running");
                      return (
                        <button
                          type="button"
                          data-history-session-id={s.id}
                          onClick={() => {
                            props.setHistoryView(false);
                            props.selectSession(s.id);
                          }}
                          class="w-full px-3.5 py-2.5 text-left hover:bg-surface-subtle transition-colors group cursor-pointer"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <div class="flex items-center gap-2 min-w-0">
                              <span class="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                                <Show
                                  when={s.pinned}
                                  fallback={
                                    <Iconify
                                      icon="lucide:message-square"
                                      size={13}
                                      class="text-fg-muted group-hover:text-fg-secondary transition-colors"
                                    />
                                  }
                                >
                                  <Iconify icon="lucide:pin" size={12} class="text-accent" />
                                </Show>
                              </span>
                              <span
                                class={`truncate text-[13px] ${
                                  unread() ? "font-medium text-fg" : "text-fg-secondary group-hover:text-fg"
                                } transition-colors`}
                              >
                                {highlightMatch(s.title, props.sessionFilter())}
                              </span>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                              <Show
                                when={unread()}
                                fallback={
                                  <Show when={running()}>
                                    <RadialSpokeSpinner size={13} class="text-fg-secondary" />
                                  </Show>
                                }
                              >
                                <UnreadDot label={props.sessionAttentionLabel?.(s) ?? "Unread update"} />
                              </Show>
                              <span class="text-2xs text-fg-muted tabular-nums">
                                {timeAgo(sessionTimeLabel(s))}
                              </span>
                            </div>
                          </div>
                          <Show
                            when={s.cwd && !isTalk(s)}
                            fallback={
                              <div class="mt-1 flex items-center gap-1.5 pl-6 text-2xs text-fg-muted">
                                <Iconify icon="lucide:messages-square" size={11} class="shrink-0" />
                                <span>Talk</span>
                              </div>
                            }
                          >
                            <div class="mt-1 flex items-center gap-1.5 pl-6 text-2xs text-fg-muted min-w-0">
                              <Iconify icon="lucide:folder" size={11} class="shrink-0" />
                              <span class="truncate font-mono">
                                {highlightMatch(s.cwd, props.sessionFilter())}
                              </span>
                            </div>
                          </Show>
                          <Show when={isCwdMatch(s)}>
                            <div class="mt-1.5 pl-6">
                              <span class="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-accent/30 bg-accent-subtle px-2 py-0.5 text-2xs font-medium text-fg">
                                <span class="shrink-0">Matched project folder:</span>
                                <span class="min-w-0 truncate font-mono text-fg-secondary">
                                  {highlightMatch(s.cwd, props.sessionFilter())}
                                </span>
                              </span>
                            </div>
                          </Show>
                        </button>
                      );
                    }}
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
