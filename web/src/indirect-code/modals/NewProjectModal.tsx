import { createMemo, For, Show } from "solid-js";
import { Badge, Btn, Kbd, Modal, ModalNotice } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useSession } from "../ctx";
import { sameRemotePath } from "../paths";

export function NewProjectModal() {
  const s = useSession();
  let lastPointerType = "mouse";

  const isCurrentValid = () => {
    if (s.folderLoading()) return false;
    const path = s.newProjectPath().trim();
    if (!path) return false;
    if (s.folderCurrent() && sameRemotePath(path, s.folderCurrent())) return true;
    return /^(?:[a-zA-Z]:[\\/]|[\\/]|~)/.test(path);
  };

  const canGoParent = () =>
    !s.folderLoading() &&
    Boolean(s.folderParent()) &&
    s.folderParent() !== s.folderCurrent();

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
    let acc = "";
    parts.forEach((part, idx) => {
      if (idx === 0 && isWin) {
        acc = `${part}${sep}`;
        crumbs.push({ label: part, path: acc });
      } else {
        acc = acc
          ? acc.endsWith(sep)
            ? `${acc}${part}`
            : `${acc}${sep}${part}`
          : normalized.startsWith("/")
            ? `/${part}`
            : part;
        crumbs.push({ label: part, path: acc });
      }
    });
    return crumbs.slice(-5);
  });

  const handleListKeyDown = (e: KeyboardEvent) => {
    const container = e.currentTarget as HTMLElement;
    const items = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[data-folder-item]:not(:disabled)"),
    );

    if (e.key === "Backspace" || e.key === "ArrowLeft") {
      if (canGoParent()) {
        e.preventDefault();
        s.requestFolders(s.folderParent());
      }
      return;
    }

    if (!items.length) return;
    const cur = items.indexOf(document.activeElement as HTMLButtonElement);

    if (e.key === "ArrowRight") {
      const focused = items[cur];
      const path = focused?.dataset.folderPath;
      if (path) {
        e.preventDefault();
        s.requestFolders(path);
      }
      return;
    }

    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }

    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? (cur + 1) % items.length
            : cur <= 0
              ? items.length - 1
              : cur - 1;
    const target = items[next];
    if (target) {
      target.focus();
      if (target.dataset.folderPath) {
        s.setNewProjectPath(target.dataset.folderPath);
      }
    }
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
      <div class="space-y-3">
        <Show when={s.folderError()}>
          <ModalNotice tone="danger" title="Filesystem error">
            {s.folderError()}
          </ModalNotice>
        </Show>

        {/* Unified Single-Border Host Directory Browser */}
        <div class="rounded-panel border border-border bg-surface overflow-hidden">
          {/* Interactive Path Breadcrumb & Quick-Jump Rail */}
          <div class="flex items-center justify-between gap-2 border-b border-border bg-surface-subtle px-3 py-2 flex-wrap">
            <div class="flex items-center gap-1 min-w-0 flex-wrap">
              <button
                type="button"
                disabled={!canGoParent()}
                onClick={() => s.requestFolders(s.folderParent())}
                data-rc-tip="Parent folder"
                aria-label="Parent folder"
                class="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11px] font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
              >
                <Iconify icon="lucide:arrow-up" size={12} />
                <span>Up</span>
              </button>

              <button
                type="button"
                onClick={() => s.requestFolders("~")}
                data-rc-tip="Home directory"
                aria-label="Home directory"
                class="inline-flex h-6 items-center gap-1 rounded-md border border-transparent px-1.5 font-mono text-[11px] text-fg-muted hover:border-border hover:bg-surface hover:text-fg transition-colors cursor-pointer"
              >
                <Iconify icon="lucide:home" size={11} />
                <span>~</span>
              </button>

              <span class="text-border-strong select-none text-xs" aria-hidden="true">
                |
              </span>

              <For each={breadcrumbs()}>
                {(crumb, idx) => {
                  const isLeaf = () => idx() === breadcrumbs().length - 1;
                  return (
                    <>
                      <Show when={idx() > 0 && crumb.label !== "/"}>
                        <span class="text-fg-muted/60 text-xs select-none" aria-hidden="true">
                          /
                        </span>
                      </Show>
                      <button
                        type="button"
                        data-rc-tip={crumb.path}
                        onClick={() => s.requestFolders(crumb.path)}
                        class={`max-w-32 truncate rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors cursor-pointer ${
                          isLeaf()
                            ? "border-border bg-surface text-fg font-medium"
                            : "border-transparent text-fg-secondary hover:border-border hover:bg-surface hover:text-fg"
                        }`}
                      >
                        {crumb.label}
                      </button>
                    </>
                  );
                }}
              </For>
            </div>

            <Show when={!s.folderLoading() && s.folderEntries()}>
              <span class="ml-auto shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">
                {s.folderEntries().length}{" "}
                {s.folderEntries().length === 1 ? "folder" : "folders"}
              </span>
            </Show>
          </div>

          {/* Direct Path Input Bar */}
          <form
            class="flex items-center gap-2 border-b border-border bg-background/60 px-3 py-1.5 focus-within:bg-surface transition-colors"
            onSubmit={(e) => {
              e.preventDefault();
              s.requestFolders(s.newProjectPath());
            }}
          >
            <Iconify icon="lucide:folder-git-2" size={14} class="shrink-0 text-fg-muted" />
            <input
              aria-label="Folder path on host"
              class="min-w-0 flex-1 bg-transparent py-1 font-mono text-xs text-fg placeholder:text-fg-muted outline-none"
              value={s.newProjectPath()}
              placeholder="/home/user/my-project"
              onInput={(e) => {
                s.setNewProjectPath(e.currentTarget.value);
                if (s.folderError()) s.setFolderError("");
              }}
            />
            <button
              type="submit"
              class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg-secondary hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
            >
              <span>Go</span>
              <Iconify icon="lucide:corner-down-left" size={12} />
            </button>
          </form>

          {/* Directory List */}
          <div
            role="group"
            aria-label="Host folders"
            onKeyDown={handleListKeyDown}
            class="h-[38vh] sm:h-60 min-h-44 overflow-y-auto divide-y divide-border/50 bg-surface [scrollbar-gutter:stable]"
          >
            <Show
              when={!s.folderLoading()}
              fallback={
                <div class="flex h-full items-center justify-center gap-2 text-xs text-fg-muted">
                  <Iconify icon="lucide:loader-2" size={15} class="animate-spin text-accent" />
                  <span>Reading directory…</span>
                </div>
              }
            >
              <For
                each={s.folderEntries()}
                fallback={
                  <div class="flex h-full flex-col items-center justify-center px-4 py-8 text-center text-xs text-fg-muted">
                    <Iconify icon="lucide:folder-open" size={20} class="mb-2 text-fg-muted" />
                    <p class="font-medium text-fg-secondary">No subdirectories here</p>
                    <p class="mt-0.5 text-[11px] text-fg-muted">
                      Choose "Open Project" to use this folder as your workspace root.
                    </p>
                  </div>
                }
              >
                {(folder) => {
                  const selected = () =>
                    Boolean(s.newProjectPath().trim()) &&
                    sameRemotePath(s.newProjectPath().trim(), folder.path);
                  return (
                    <div
                      class={`flex items-center justify-between gap-1 px-2 py-0.5 transition-colors group ${
                        selected() ? "bg-accent-subtle/50" : "hover:bg-surface-subtle"
                      }`}
                    >
                      <button
                        type="button"
                        data-folder-item=""
                        data-folder-path={folder.path}
                        onPointerDown={(e) => {
                          lastPointerType = e.pointerType || "mouse";
                        }}
                        onClick={(e) => {
                          if (e.detail === 0) {
                            s.requestFolders(folder.path);
                            return;
                          }
                          if (lastPointerType === "touch" && selected()) {
                            s.requestFolders(folder.path);
                            return;
                          }
                          s.setNewProjectPath(folder.path);
                          if (s.folderError()) s.setFolderError("");
                        }}
                        onDblClick={() => s.requestFolders(folder.path)}
                        class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-fg cursor-pointer"
                      >
                        <Iconify
                          icon={selected() ? "lucide:folder-open" : "lucide:folder"}
                          size={14}
                          class={`shrink-0 transition-colors ${
                            selected() ? "text-accent" : "text-fg-muted group-hover:text-fg-secondary"
                          }`}
                        />
                        <span
                          class={`truncate font-mono text-xs ${
                            selected() ? "font-medium text-fg" : "text-fg-secondary group-hover:text-fg"
                          }`}
                        >
                          {folder.name}
                        </span>
                      </button>

                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={`Open ${folder.name}`}
                        onClick={() => s.requestFolders(folder.path)}
                        class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer shrink-0"
                      >
                        <span class="hidden sm:inline">Open</span>
                        <Iconify icon="lucide:chevron-right" size={13} />
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>

          {/* Selection Status & Keyboard Hint Bar */}
          <div class="flex items-center justify-between gap-2 border-t border-border bg-surface-subtle px-3 py-2 text-xs flex-wrap">
            <div class="flex items-center gap-2 min-w-0 flex-1">
              <Iconify
                icon="lucide:folder-check"
                size={13}
                class={isCurrentValid() ? "shrink-0 text-accent" : "shrink-0 text-fg-muted"}
              />
              <span class="truncate font-mono text-[11px] text-fg-secondary">
                {s.newProjectPath().trim() || "No folder selected"}
              </span>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="hidden sm:inline-flex items-center gap-1 text-[11px] text-fg-muted">
                <span>Double-click or</span>
                <Kbd>Enter</Kbd>
                <span>to browse</span>
              </span>
              <Badge tone={isCurrentValid() ? "green" : "zinc"}>
                {isCurrentValid() ? "Ready" : "Select path"}
              </Badge>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
