import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { absoluteRemotePath, collapseCwd } from "../../paths";
import { ShellCmd } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import type { ToolPartProps } from "./toolUnitModel";

export function ToolUnitHeader(props: ToolPartProps) {
  const targetPath = () => {
    if (props.m.name().startsWith("mcp__")) return "";
    const a = props.m.args();
    if (a.path) return String(a.path);
    if (a.file) return String(a.file);
    if (Array.isArray(a.edits) && a.edits.length === 1) {
      return String(a.edits[0]?.path || a.edits[0]?.file || "");
    }
    return "";
  };

  return (
    <div
      onPointerDown={(e) => {
        if (props.m.expandable()) press(e.currentTarget);
      }}
      onClick={props.m.toggle}
      class="group/tool w-full flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-lg cursor-pointer hover:bg-surface-muted/70 transition-colors text-[13px]"
    >
      <Show
        when={!(props.running && props.active && !props.u.result)}
        fallback={
          <span class="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
        }
      >
        <Iconify
          icon={props.m.sum().icon}
          size={14}
          class="shrink-0 text-fg-muted group-hover/tool:text-fg-secondary transition-colors"
        />
      </Show>
      <span class="text-fg-muted shrink-0">{props.m.sum().verb}</span>
      <span class="flex items-center gap-2 min-w-0 flex-1">
        <span class="inline-flex items-center gap-2 min-w-0 flex-1" data-rc-tip={targetPath() ? absoluteRemotePath(targetPath(), props.ctx.activeSession()?.cwd || "", props.ctx.projects().find((p: { protected?: boolean }) => p.protected)?.path) : undefined}>
          <Show when={targetPath()}><FileIcon path={targetPath()} /></Show>
          <Show when={props.m.name() === "bash" || props.m.name() === "exec_script" || props.m.name() === "python"} fallback={
            <span class="truncate text-fg font-medium min-w-0">{props.m.name() === "bg_await" ? props.m.sleepLabel() : props.m.sum().target}</span>
          }>
            <span class="truncate text-fg min-w-0 text-[12.5px]"><ShellCmd prompt={props.m.name() === "exec_script" || props.m.name() === "python" ? "> " : "$ "} text={collapseCwd(props.m.bashHeaderCmd(), props.ctx.activeSession()?.cwd || "")} /></span>
          </Show>
        </span>
      </span>
      <Show when={props.m.sum().statAdd != null || props.m.sum().statDel != null}>
        <span class="font-mono text-[11px] shrink-0 tabular-nums">
          <Show when={(props.m.sum().statAdd || 0) > 0}>
            <span class="text-success">+{props.m.sum().statAdd}</span>
          </Show>
          <Show when={(props.m.sum().statAdd || 0) > 0 && (props.m.sum().statDel || 0) > 0}>
            <span class="text-fg-muted"> </span>
          </Show>
          <Show when={(props.m.sum().statDel || 0) > 0}>
            <span class="text-danger">-{props.m.sum().statDel}</span>
          </Show>
        </span>
      </Show>
      <Show when={props.m.sum().stat && props.m.sum().statAdd == null}>
        <span class="text-[11px] text-fg-muted shrink-0">{props.m.sum().stat}</span>
      </Show>
      <Show when={props.m.elapsed() && !props.m.isDetachedBg()}><span data-tool-duration class="text-[11px] text-fg-muted tabular-nums shrink-0">{props.m.elapsed()}</span></Show>
      {/* Header-only rows (bg_await) keep the clickable row but hide the
          chevron: there is never a body to reveal. */}
      <Show when={props.m.expandable()}>
        <Iconify
          icon="lucide:chevron-down"
          size={12}
          class={`shrink-0 text-fg-muted transition-transform ${props.m.open() ? "rotate-180" : ""}`}
        />
      </Show>
    </div>
  );
}
