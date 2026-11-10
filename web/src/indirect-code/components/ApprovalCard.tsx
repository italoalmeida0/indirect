import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { press } from "../../ds/motion/press";
import { FileIcon } from "../presentation";
import { tryParseArgs } from "../utils/tools";
import { formatDurationSecs } from "../utils/format";
import { useBackground } from "../ctx";
import type { PendingApproval } from "../types";

/** Tool call approval card (extracted from TranscriptView without
 * visual changes — narrow props instead of the god-ctx). */
export interface ApprovalCardProps {
  pendingApproval: () => PendingApproval | null;
  convWidthClass: () => string;
  respondApproval: (approved: boolean, always?: boolean) => void;
  setYoloMode: (v: boolean) => void;
}

export function ApprovalCard(props: ApprovalCardProps) {
  const jobs = useBackground().sessionJobs;
  return (
    <Show when={props.pendingApproval()}>
      {(pa) => {
        const args = tryParseArgs(pa().args);
        const name = pa().tool || "tool";
        const legacyLang = typeof args.legacy_lang === "string" ? args.legacy_lang.trim().toLowerCase() : "";
        const isUnsupportedLegacyPython = name === "python" || (name === "exec_script" && (legacyLang === "python" || legacyLang === "python3" || (!String(args.code || "").trim() && Boolean(String(args.script || "").trim()))));
        const editList = (() => {
          const raw = args.edits;
          if (Array.isArray(raw)) return raw;
          if (typeof raw === "string") {
            try {
              const p = JSON.parse(raw);
              if (Array.isArray(p)) return p;
              if (p && typeof p === "object") return [p];
            } catch {}
          } else if (raw && typeof raw === "object") {
            return [raw];
          }
          return [];
        })();
        return (
          <div class={`${props.convWidthClass()} mx-auto rc-studio-card rounded-2xl p-4 shadow-raised`}>
            <div class="flex items-center gap-2.5 text-[13px] flex-wrap">
              <div class="w-7 h-7 rounded-lg bg-accent-subtle border border-accent/25 flex items-center justify-center text-accent shrink-0">
                <Iconify icon="lucide:shield-check" size={15} />
              </div>
              <span class="font-medium text-fg">Review tool call</span>
              <span class="rounded-md border border-border bg-surface-subtle px-2 py-0.5 font-mono text-[11px] text-fg-secondary">
                {name}
              </span>
              <span class="ml-auto text-[11px] text-fg-muted flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-warning" />
                Safe mode · nothing ran yet
              </span>
            </div>
            {/* Human summary per tool (never raw JSON) */}
            <div class="mt-3 rc-studio-well rounded-xl overflow-hidden">
              <Show when={name === "bash"}>
                <div class="px-3.5 py-2.5">
                  <div class="text-[11px] font-medium text-fg-muted mb-1">Run command</div>
                  <pre class="font-mono text-[13px] text-fg whitespace-pre-wrap break-all max-h-56 overflow-y-auto">{String(args.command || "")}</pre>
                  <div class="mt-1.5 text-[11px] text-fg-muted">Still running after 10s → moves to the background automatically.</div>
                </div>
              </Show>
              <Show when={name === "exec_script" || name === "python"}>
                <div class="px-3.5 py-2.5">
                  <div class="text-[11px] font-medium text-fg-muted mb-1">{isUnsupportedLegacyPython ? "Unsupported legacy Python call" : "Run JavaScript"}</div>
                  <pre class="font-mono text-[13px] text-fg whitespace-pre-wrap break-all max-h-56 overflow-y-auto">{String(args.code || args.script || "")}</pre>
                  <Show when={args.work_dir}>
                    <div class="mt-1.5 text-[11px] text-fg-secondary font-mono">cwd: {String(args.work_dir)}</div>
                  </Show>
                  <Show when={args.env && typeof args.env === "object" && Object.keys(args.env as Record<string, unknown>).length > 0}>
                    <div class="mt-1 text-[11px] text-fg-secondary font-mono">
                      env: {Object.entries(args.env as Record<string, unknown>).map(([k, v]) => `${k}=${String(v ?? "")}`).join(" ")}
                    </div>
                  </Show>
                  <Show when={args.stdin}>
                    <div class="mt-1 text-[11px] text-fg-secondary font-mono truncate">stdin: {String(args.stdin)}</div>
                  </Show>
                  <div class="mt-1.5 text-[11px] text-fg-muted">
                    {isUnsupportedLegacyPython
                      ? "Legacy Python execution was removed — reject so the agent rewrites the snippet as JavaScript."
                      : "Still running after 10s → moves to the background automatically."}
                  </div>
                </div>
              </Show>
              <Show when={name === "bg_await"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:timer" size={14} class="text-fg-secondary shrink-0" />
                  <span class="text-fg-muted">Wait</span>
                  <span class="font-mono text-fg">{args.max_wait_seconds ? formatDurationSecs(Number(args.max_wait_seconds)) : ""}</span>
                  <span class="text-[11px] text-fg-muted">{args.reason ? String(args.reason) : "ends early when a background task finishes"}</span>
                </div>
              </Show>
              <Show when={name === "bg_cancel"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:octagon-x" size={14} class="text-danger shrink-0" />
                  <span class="text-fg-muted">Stop background task</span>
                  <span class="font-mono text-fg truncate">{(() => {
                    const id = String(args.job_id || "");
                    const job = jobs().find((j) => j.id === id);
                    return job?.label || id || "unknown";
                  })()}</span>
                </div>
              </Show>
              <Show when={name === "read"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <FileIcon path={String(args.path || "")} size={14} />
                  <span class="text-fg-muted">Read</span>
                  <span class="font-mono text-fg truncate">{String(args.path || "")}</span>
                  <Show when={args.limit || args.offset}>
                    <span class="font-mono text-[11px] text-fg-muted shrink-0">
                      {(() => {
                        const off = Math.max(1, Number(args.offset || 1));
                        const lim = Number(args.limit || 0);
                        return lim > 0 ? `L${off}-${off + lim - 1}` : `L${off}+`;
                      })()}
                    </span>
                  </Show>
                </div>
              </Show>
              <Show when={name === "write"}>
                <div class="px-3.5 py-2.5 text-[13px]">
                  <div class="flex items-center gap-2">
                    <FileIcon path={String(args.path || "")} size={14} />
                    <span class="text-fg-muted">Create</span>
                    <span class="font-mono text-fg truncate">{String(args.path || "")}</span>
                  </div>
                  <Show when={args.content}>
                    <pre class="mt-2 font-mono text-[11px] text-fg-secondary whitespace-pre-wrap max-h-32 overflow-y-auto border-t border-border/60 pt-2">
                      {String(args.content).split("\n").slice(0, 12).join("\n")}
                      {String(args.content).split("\n").length > 12 ? "\n…" : ""}
                    </pre>
                  </Show>
                </div>
              </Show>
              <Show when={name === "edit"}>
                <div class="px-3.5 py-2.5 text-[13px]">
                  <div class="flex items-center gap-2">
                    <FileIcon path={String(args.path || "")} size={14} />
                    <span class="text-fg-muted">Edit</span>
                    <span class="font-mono text-fg truncate">{String(args.path || "")}</span>
                    <Show when={editList.length > 0}>
                      <span class="text-[11px] text-fg-muted shrink-0">
                        {editList.length} change{editList.length === 1 ? "" : "s"}
                      </span>
                    </Show>
                  </div>
                  <Show when={editList.length > 0}>
                    <div class="mt-2 rounded-lg overflow-hidden border border-border/70 font-mono text-[11px]">
                      <For each={editList.slice(0, 2)}>
                        {(e: any) => (
                          <>
                            <div class="px-2.5 py-1 bg-danger-subtle text-danger whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                              {(String(e.old_text || "").split("\n").slice(0, 6).join("\n"))}
                            </div>
                            <div class="px-2.5 py-1 bg-success-subtle text-success whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                              {(String(e.new_text || "").split("\n").slice(0, 6).join("\n"))}
                            </div>
                          </>
                        )}
                      </For>
                      <Show when={editList.length > 2}>
                        <div class="px-2.5 py-1 text-fg-muted">+{editList.length - 2} more changes</div>
                      </Show>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={name === "glob"}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:search" size={14} class="text-fg-secondary shrink-0" />
                  <span class="text-fg-muted">Search files</span>
                  <span class="font-mono text-fg truncate">{String(args.pattern || "")}</span>
                </div>
              </Show>
              <Show when={name === "todo"}>
                <div class="px-3.5 py-2.5 text-xs"><p class="font-medium text-fg mb-2">Update task plan</p><ul class="space-y-1 text-fg-secondary"><For each={args.items || []}>{(item) => <li class="flex gap-2"><span class="text-fg-muted">{String(item.status).replaceAll("_", " ")}</span><span>{item.text}</span></li>}</For></ul></div>
              </Show>
              <Show when={!["bash", "exec_script", "python", "bg_await", "bg_cancel", "read", "write", "edit", "glob", "todo"].includes(name)}>
                <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                  <Iconify icon="lucide:wrench" size={14} class="text-fg-secondary shrink-0" />
                  <span class="font-mono text-fg">{name}</span>
                </div>
              </Show>
              <details>
                <summary class="px-3.5 py-1.5 text-[11px] text-fg-muted hover:text-fg-secondary cursor-pointer select-none border-t border-border/60 transition-colors">
                  Details
                </summary>
                <pre class="px-3.5 pb-3 font-mono text-[11px] text-fg-secondary overflow-x-auto whitespace-pre-wrap max-h-40">
                  {pa().args}
                </pre>
              </details>
            </div>
            <div class="mt-3.5 flex items-center justify-end gap-2 flex-wrap">
              <button
                onPointerDown={(e) => press(e.currentTarget)}
                onClick={() => props.respondApproval(false)}
                class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-fg-secondary hover:text-fg border border-border bg-surface hover:bg-surface-muted transition-colors cursor-pointer"
              >
                Reject
              </button>
              <Show when={!isUnsupportedLegacyPython}>
                <button
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => props.respondApproval(true)}
                  class="px-4 py-1.5 rounded-xl bg-accent hover:bg-accent-strong text-accent-foreground text-xs font-medium border border-transparent shadow-2xs transition-colors cursor-pointer"
                >
                  Allow once
                </button>
                <button
                  onPointerDown={(e) => press(e.currentTarget)}
                  onClick={() => {
                    props.setYoloMode(true);
                    props.respondApproval(true, true);
                  }}
                  class="px-3.5 py-1.5 rounded-xl border border-accent/35 bg-accent-subtle text-accent hover:bg-accent hover:text-accent-foreground text-xs font-medium transition-colors cursor-pointer"
                  data-rc-tip="Enable Full access and allow all tool calls" aria-label="Always allow — enable Full access"
                >
                  Always allow
                </button>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
