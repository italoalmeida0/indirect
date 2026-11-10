import { createMemo, For, Show } from "solid-js";
import { Badge, Btn, Modal, ModalNotice } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useSession } from "../ctx";
import { sameRemotePath } from "../paths";

export function NewProjectModal() {
  const s = useSession();

  const isCurrentValid = () => {
    if (s.folderLoading()) return false;
    const path = s.newProjectPath().trim();
    if (!path) return false;
    if (s.folderCurrent() && sameRemotePath(path, s.folderCurrent())) return true;
    return /^(?:[a-zA-Z]:[\\/]|[\\/]|~)/.test(path);
  };

  const breadcrumbs = createMemo(() => {
    const raw = (s.folderCurrent() || s.newProjectPath()).trim();
    if (!raw) return [] as Array<{ label: string; path: string }>;
    const isWin = /^[a-zA-Z]:[\\/]/.test(raw);
    const sep = isWin && raw.includes("\\") ? "\\" : "/";
    const normalized = raw.replace(/[\\/]+/g, sep);
    const parts = normalized.split(sep).filter(Boolean);
    const crumbs: Array<{ label: string; path: string }> = [];
    if (normalized.startsWith("/")) {
      crumbs.push({ label: "/", path: "/" });
    }
    let acc = normalized.startsWith("/") ? "" : "";
    parts.forEach((part, idx) => {
      if (idx === 0 && isWin) {
        acc = `${part}${sep}`;
        crumbs.push({ label: part, path: acc });
      } else {
        acc = acc ? (acc.endsWith(sep) ? `${acc}${part}` : `${acc}${sep}${part}`) : (normalized.startsWith("/") ? `/${part}` : part);
        crumbs.push({ label: part, path: acc });
      }
    });
    return crumbs.slice(-5);
  });

  const handleListKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const container = e.currentTarget as HTMLElement;
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    if (!buttons.length) return;
    e.preventDefault();
    const cur = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? (cur + 1) % buttons.length
        : cur <= 0
          ? buttons.length - 1
          : cur - 1;
    buttons[next]?.focus();
  };

  return (
    <Modal
      open={s.showNewProjectModal()}
      onClose={() => {
        s.setShowNewProjectModal(false);
        s.newProjBtn?.focus();
      }}
      title="Select project folder"
      subtitle="Browse the host filesystem to choose or initialize a workspace for your agent sessions."
      width="max-w-2xl"
      footer={
        <>
          <Btn
            variant="outline"
            size="sm"
            onClick={() => {
              s.setShowNewProjectModal(false);
              s.newProjBtn?.focus();
            }}
          >
            Cancel
          </Btn>
          <Btn
            size="sm"
            disabled={!isCurrentValid()}
            onClick={s.createProject}
          >
            Open Project
          </Btn>
        </>
      }
    >
      <div class="space-y-3.5">
        {/* Host Filesystem Quick-Jump & OS Syntax Bar */}
        <div class="flex items-center justify-between gap-2 flex-wrap text-xs" aria-hidden="true">
          <div class="flex items-center gap-1.5">
            <span class="text-fg-muted text-[11px]">Quick jump:</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => s.requestFolders("~")}
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-border bg-surface-subtle hover:bg-surface-muted text-fg-secondary hover:text-fg font-mono text-[11px] cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:home" size={11} class="text-accent" />
              <span>~ Home</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => s.requestFolders("/")}
              class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-border bg-surface-subtle hover:bg-surface-muted text-fg-secondary hover:text-fg font-mono text-[11px] cursor-pointer transition-colors"
            >
              <Iconify icon="lucide:hard-drive" size={11} class="text-fg-muted" />
              <span>/ Root</span>
            </button>
          </div>
          <span class="text-[11px] font-mono text-fg-secondary bg-surface-subtle px-2 py-0.5 rounded-md border border-border">
            {/^[a-zA-Z]:[\\/]/.test(s.newProjectPath().trim()) ? "Windows Drive Path" : "POSIX Host Path"}
          </span>
        </div>

        {/* Navigation / Path input bar */}
        <form
          class="rc-studio-well flex items-center gap-2 p-1.5 focus-within:border-accent transition-all"
          onSubmit={(e) => {
            e.preventDefault();
            s.requestFolders(s.newProjectPath());
          }}
        >
          <div class="pl-2 text-accent shrink-0">
            <Iconify icon="lucide:folder-tree" size={15} />
          </div>
          <input
            aria-label="Folder path on host"
            class="flex-1 min-w-0 bg-transparent px-1.5 py-1.5 text-xs sm:text-sm font-mono text-fg placeholder:text-fg-muted outline-none"
            value={s.newProjectPath()}
            placeholder="/home/user/my-project"
            onInput={(e) => {
              s.setNewProjectPath(e.currentTarget.value);
              if (s.folderError()) s.setFolderError("");
            }}
          />
          <button
            type="submit"
            class="px-3 py-1.5 rounded-control text-xs font-medium text-fg-secondary hover:text-fg bg-surface hover:bg-surface-muted transition-colors flex items-center gap-1 cursor-pointer shrink-0 border border-border"
          >
            <span>Go</span>
            <Iconify icon="lucide:arrow-right" size={13} />
          </button>
        </form>

        <Show when={s.folderError()}>
          <ModalNotice tone="danger" title="Filesystem error">
            {s.folderError()}
          </ModalNotice>
        </Show>

        {/* Directory browser container */}
        <div class="rc-studio-card overflow-hidden">
          <div class="flex items-center justify-between gap-3 px-3.5 py-2 border-b border-border bg-surface-muted/50 flex-wrap">
            <div class="flex items-center gap-1 min-w-0 flex-wrap">
              <For each={breadcrumbs()}>
                {(crumb, idx) => (
                  <>
                    <Show when={idx() > 0}>
                      <span class="text-fg-muted/60 text-xs select-none">/</span>
                    </Show>
                    <button
                      type="button"
                      onClick={() => s.requestFolders(crumb.path)}
                      class="px-2 py-0.5 rounded-md text-xs font-mono text-fg-secondary hover:text-fg hover:bg-surface border border-transparent hover:border-border transition-colors cursor-pointer truncate max-w-36"
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </For>
            </div>
            <div class="flex items-center gap-2 shrink-0 ml-auto">
              <Show when={!s.folderLoading() && s.folderEntries()}>
                <span class="text-[11px] text-fg-muted font-mono">
                  {s.folderEntries().length} {s.folderEntries().length === 1 ? "folder" : "folders"}
                </span>
              </Show>
              <button
                type="button"
                disabled={
                  s.folderLoading() ||
                  !s.folderParent() ||
                  s.folderParent() === s.folderCurrent()
                }
                onClick={() => s.requestFolders(s.folderParent())}
                class="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-fg-secondary hover:text-fg bg-surface hover:bg-surface-muted border border-border transition-colors disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <Iconify icon="lucide:arrow-up" size={13} />
                <span>Parent</span>
              </button>
            </div>
          </div>

          <div
            role="group"
            aria-label="Host folders"
            onKeyDown={handleListKeyDown}
            class="h-[42vh] sm:h-64 min-h-44 overflow-y-auto p-2 space-y-0.5 bg-surface/60 [scrollbar-gutter:stable]"
          >
            <Show
              when={!s.folderLoading()}
              fallback={
                <div class="flex items-center justify-center h-full text-xs text-fg-muted gap-2">
                  <Iconify icon="lucide:loader-2" size={16} class="animate-spin text-accent" />
                  <span>Scanning folders…</span>
                </div>
              }
            >
              <For
                each={s.folderEntries()}
                fallback={
                  <div class="flex flex-col items-center justify-center h-full py-8 text-center text-xs text-fg-muted">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-surface-subtle text-fg-muted mb-2.5">
                      <Iconify icon="lucide:folder-open" size={20} />
                    </div>
                    <p class="font-medium text-fg-secondary">No subfolders found in this directory.</p>
                    <p class="text-[11px] text-fg-muted mt-0.5">Click "Open Project" below to select this folder.</p>
                  </div>
                }
              >
                {(folder) => (
                  <button
                    type="button"
                    aria-label={`Open ${folder.name}`}
                    onClick={() => s.requestFolders(folder.path)}
                    class="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-xs sm:text-sm text-fg-secondary hover:text-fg hover:bg-surface-muted focus-visible:bg-surface-muted outline-none transition-colors cursor-pointer group"
                  >
                    <span class="flex items-center gap-2.5 min-w-0 truncate">
                      <Iconify
                        icon="lucide:folder"
                        size={15}
                        class="shrink-0 text-fg-muted group-hover:text-accent transition-colors"
                      />
                      <span class="truncate font-mono text-xs">{folder.name}</span>
                    </span>
                    <Iconify
                      icon="lucide:chevron-right"
                      size={14}
                      class="shrink-0 text-fg-muted/70 group-hover:text-fg transition-transform group-hover:translate-x-0.5"
                    />
                  </button>
                )}
              </For>
            </Show>
          </div>
          <div class="flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-border bg-surface-muted/40 text-xs">
            <div class="flex items-center gap-2 min-w-0">
              <Iconify icon="lucide:folder-check" size={14} class="text-accent shrink-0" />
              <span class="font-mono text-fg-secondary truncate">
                {s.newProjectPath().trim() || "No folder selected"}
              </span>
            </div>
            <Badge tone={isCurrentValid() ? "green" : "zinc"}>
              {isCurrentValid() ? "Ready" : "Select path"}
            </Badge>
          </div>
        </div>
      </div>
    </Modal>
  );
}
