/** The composer/task-plan collapse predicate, shared by Composer and
 * StatusBanners so the two can never diverge (the whole shell minimizes
 * together). The persisted preference only bites in an existing, available
 * conversation — a new conversation (draftMode) has nothing to minimize into. */
export interface ComposerCollapseState {
  composerCollapsed: boolean;
  draftMode: boolean;
  activeSessionId: string;
  workspaceBlocked: boolean;
}

export function composerIsCollapsed(s: ComposerCollapseState): boolean {
  return s.composerCollapsed && !s.draftMode && !!s.activeSessionId && !s.workspaceBlocked;
}
