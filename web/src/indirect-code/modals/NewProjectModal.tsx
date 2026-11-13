import { createMemo, For, Show } from "solid-js";
import { press } from "../../ds/motion/press";
import { Btn, Kbd, Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useSession } from "../ctx";
import { sameRemotePath } from "../paths";

export function NewProjectModal() {
  const s = useSession();

  const closeModal = () => {
    s.setShowNewProjectModal(false);
    s.newProjBtn?.focus();
  };

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
    return crumbs.slice(-7);
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
    items[next]?.focus();
  };

  return (
    <Modal
      open={s.showNewProjectModal()}
      onClose={closeModal}
      title="Select project folder"
      width="max-w-2xl"
      chromeless
    >
      {/* Top Navigation, Breadcrumbs & Close */}
      <div class="flex items-center gap-1 border-b border-border-subtle bg-surface-subtle/60 px-4 py-2.5">
        <button
          type="button"
          disabled={!canGoParent()}
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => s.requestFolders(s.folderParent())}
          data-rc-tip="Parent folder"
          aria-label="Parent folder"
          class="ui-icon-button h-7 w-7 shrink-0 rounded-lg"
        >
          <Iconify icon="lucide:arrow-up" size={14} />
        </button>

        <button
          type="button"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={() => s.requestFolders("~")}
          data-rc-tip="Home directory"
          aria-label="Home directory"
          class="ui-icon-button h-7 w-7 shrink-0 rounded-lg"
        >
          <Iconify icon="lucide:home" size={14} />
        </button>

        <span class="mx-1 h-3.5 w-px shrink-0 bg-border-subtle" aria-hidden="true" />

        <div class="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <For
            each={breadcrumbs()}
            fallback={
              <span class="truncate px-2 text-xs font-medium text-fg-secondary">
                Select project folder
              </span>
            }
          >
            {(crumb, idx) => {
              const isLeaf = () => idx() === breadcrumbs().length - 1;
              return (
                <>
                  <Show when={idx() > 0 && crumb.label !== "/"}>
                    <span class="text-fg-muted/50 text-xs select-none shrink-0" aria-hidden="true">
                      /
                    </span>
                  </Show>
                  <button
                    type="button"
                    data-rc-tip={crumb.path}
                    onPointerDown={(e) => press(e.currentTarget)}
                    onClick={() => s.requestFolders(crumb.path)}
                    class={`max-w-44 shrink-0 truncate rounded-md px-2 py-1 font-mono text-xs transition-colors cursor-pointer ${
                      isLeaf()
                        ? "bg-surface-muted text-fg font-medium"
                        : "text-fg-secondary hover:bg-surface-muted hover:text-fg"
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
          <span class="hidden sm:inline shrink-0 px-1.5 text-2xs text-fg-muted tabular-nums">
            {s.folderEntries().length}{" "}
            {s.folderEntries().length === 1 ? "folder" : "folders"}
          </span>
        </Show>

        <button
          type="button"
          aria-label="Close"
          data-rc-tip="Close"
          onPointerDown={(e) => press(e.currentTarget)}
          onClick={closeModal}
          class="ui-icon-button h-7 w-7 shrink-0 rounded-lg"
        >
          <Iconify icon="lucide:x" size={15} />
        </button>
      </div>

      {/* Direct Path Input Bar */}
      <form
        class="flex items-center gap-2.5 border-b border-border-subtle bg-surface/50 px-4 py-2 focus-within:bg-surface transition-colors"
        onSubmit={(e) => {
          e.preventDefault();
          s.requestFolders(s.newProjectPath());
        }}
      >
        <Iconify
          icon="lucide:folder-git-2"
          size={14}
          class={`shrink-0 transition-colors ${isCurrentValid() ? "text-accent" : "text-fg-muted"}`}
        />
        <input
          aria-label="Folder path on host"
          class="min-w-0 flex-1 bg-transparent py-0.5 font-mono text-xs text-fg placeholder:text-fg-muted outline-none"
          value={s.newProjectPath()}
          placeholder="/home/user/my-project"
          ref={(el) => {
            if (typeof window !== "undefined" && !window.matchMedia?.("(pointer: coarse)").matches) {
              setTimeout(() => el?.focus(), 40);
            }
          }}
          onInput={(e) => {
            s.setNewProjectPath(e.currentTarget.value);
            if (s.folderError()) s.setFolderError("");
          }}
        />
        <button
          type="submit"
          data-rc-tip="Navigate to path"
          onPointerDown={(e) => press(e.currentTarget)}
          class="inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium text-fg-muted hover:bg-surface-muted hover:text-fg transition-colors cursor-pointer"
        >
          <span>Go</span>
          <Iconify icon="lucide:corner-down-left" size={11} />
        </button>
      </form>

      <Show when={s.folderError()}>
        <div
          role="alert"
          class="flex items-center gap-2 border-b border-danger/25 bg-danger-subtle px-4 py-2 text-xs text-danger"
        >
          <Iconify icon="lucide:alert-circle" size={14} class="shrink-0" />
          <span class="min-w-0 flex-1 break-words">{s.folderError()}</span>
        </div>
      </Show>

      {/* Directory List */}
      <div
        role="group"
        aria-label="Host folders"
        onKeyDown={handleListKeyDown}
        class="h-[min(54vh,25rem)] min-h-48 overflow-y-auto p-2 space-y-0.5"
      >
        <Show
          when={!s.folderLoading()}
          fallback={
            <div class="flex h-full items-center justify-center gap-2 text-xs text-fg-muted">
              <span class="ui-spinner ui-spinner-sm text-accent" aria-hidden="true" />
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
                <p class="mt-0.5 text-2xs text-fg-muted">
                  Choose "Open this folder" to use this directory as your workspace root.
                </p>
              </div>
            }
          >
            {(folder) => {
              const selected = () =>
                Boolean(s.newProjectPath().trim()) &&
                sameRemotePath(s.newProjectPath().trim(), folder.path);
              return (
                <button
                  type="button"
                  data-folder-item=""
                  data-folder-path={folder.path}
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => {
                    if (s.folderError()) s.setFolderError("");
                    s.requestFolders(folder.path);
                  }}
                  class={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2 py-1 text-left transition-colors cursor-pointer group ${
                    selected()
                      ? "bg-accent-subtle text-fg"
                      : "text-fg-secondary hover:bg-surface-muted/75 hover:text-fg"
                  }`}
                >
                  <span class="flex min-w-0 flex-1 items-center gap-2.5">
                    <Iconify
                      icon={selected() ? "lucide:folder-open" : "lucide:folder"}
                      size={14}
                      class={`shrink-0 transition-colors ${
                        selected() ? "text-accent" : "text-fg-muted group-hover:text-fg-secondary"
                      }`}
                    />
                    <span
                      class={`truncate font-mono text-xs ${
                        selected() ? "font-medium text-fg" : ""
                      }`}
                    >
                      {folder.name}
                    </span>
                  </span>
                  <Iconify
                    icon="lucide:chevron-right"
                    size={14}
                    class="shrink-0 text-fg-muted/70 group-hover:text-fg transition-colors"
                  />
                </button>
              );
            }}
          </For>
        </Show>
      </div>

      {/* Unified Footer */}
      <div class="flex items-center justify-between gap-3 border-t border-border-subtle bg-surface-subtle/60 px-4 py-3">
        <span class="hidden sm:inline-flex items-center gap-1.5 text-2xs text-fg-muted select-none">
          <span>Click a folder or press</span>
          <Kbd>Enter</Kbd>
          <span>to browse</span>
        </span>
        <div class="ml-auto flex items-center gap-2">
          <Btn variant="outline" size="sm" onClick={closeModal}>
            Cancel
          </Btn>
          <Btn size="sm" disabled={!isCurrentValid()} onClick={s.createProject}>
            Open this folder
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
