import { Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { press } from "../../../ds/motion/press";
import { createShimmerStyle } from "../../../ds/motion/shimmer";
import { absoluteRemotePath, collapseCwd } from "../../paths";
import { latestExploreProgress } from "../../utils/contextTools";
import { ShellCmd } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import type { ToolPartProps } from "./toolUnitModel";

export function ToolUnitHeader(props: ToolPartProps) {
  const targetPath = () => {
    const n = props.m.name();
    if (n.startsWith("mcp__")) return "";
    const a = props.m.args();
    if (a.path) return String(a.path);
    if (a.file) return String(a.file);
    if (n === "widget_set" && a.src_file) return String(a.src_file);
    if (Array.isArray(a.edits) && a.edits.length === 1) {
      return String(a.edits[0]?.path || a.edits[0]?.file || "");
    }
    return "";
  };

  const isMonoIdentifier = () => {
    const n = props.m.name();
    return (
      n === "use_skill" ||
      n === "widget_set" ||
      n === "widget_edit" ||
      n === "widget_read" ||
      n === "widget_lint" ||
      n === "bg_tail"
    );
  };

  const verbActive = () => Boolean(props.running && props.active && !props.u.result);
  const verbShimmerStyle = createShimmerStyle(verbActive);

  return (
    <div
      onPointerDown={(e) => {
        if (props.m.expandable()) press(e.currentTarget);
      }}
      onClick={props.m.toggle}
      class={`group/tool w-full flex items-center gap-2 py-0.5 px-1.5 -ml-1.5 rounded-md transition-colors text-[12.5px] ${
        props.m.expandable() ? "cursor-pointer hover:bg-surface-muted/55" : ""
      }`}
    >
      <Iconify
        icon={props.m.sum().icon}
        size={13}
        class="shrink-0 text-fg-muted/80 group-hover/tool:text-fg-secondary transition-colors"
      />
      <span class={`shrink-0 ${verbActive() ? "ui-shimmer font-medium text-fg-secondary" : "text-fg-muted"}`} style={verbShimmerStyle()}>{props.m.sum().verb}</span>
      <span class="flex items-center gap-1.5 min-w-0 flex-1">
        <span class="inline-flex items-center gap-1.5 min-w-0 flex-1" data-rc-tip={targetPath() ? absoluteRemotePath(targetPath(), props.ctx.activeSession()?.cwd || "", props.ctx.projects().find((p: { protected?: boolean }) => p.protected)?.path) : undefined}>
          <Show when={targetPath()}><FileIcon path={targetPath()} size={13} /></Show>
          <Show when={props.m.name() === "bash" || props.m.name() === "exec_script" || props.m.name() === "python"} fallback={
            <span class={`truncate text-fg-secondary group-hover/tool:text-fg min-w-0 transition-colors ${isMonoIdentifier() ? "font-mono text-[12px]" : ""}`}>{props.m.name() === "bg_await" ? props.m.sleepLabel() : props.m.sum().target}</span>
          }>
            <span class="truncate text-fg-secondary group-hover/tool:text-fg min-w-0 text-[12px] transition-colors"><ShellCmd prompt={props.m.name() === "exec_script" || props.m.name() === "python" ? "> " : "$ "} text={collapseCwd(props.m.bashHeaderCmd(), props.ctx.activeSession()?.cwd || "")} /></span>
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
        <span class="text-[11px] text-fg-muted/80 shrink-0 tabular-nums">{props.m.sum().stat}</span>
      </Show>
      <Show when={props.m.name() === "explore" && props.running && props.active && !props.u.result && latestExploreProgress(props.m.prog())}>
        <span data-explore-step class="font-mono text-[11px] text-accent truncate max-w-[14rem] shrink-0">{latestExploreProgress(props.m.prog())}</span>
      </Show>
      <Show when={props.m.elapsed() && !props.m.isDetachedBg()}><span data-tool-duration class="text-[11px] text-fg-muted/80 tabular-nums shrink-0">{props.m.elapsed()}</span></Show>
      {/* Header-only rows (bg_await) keep the clickable row but hide the
          chevron: there is never a body to reveal. */}
      <Show when={props.m.expandable()}>
        <Iconify
          icon="lucide:chevron-right"
          size={12}
          class={`shrink-0 text-fg-muted/60 group-hover/tool:text-fg-muted transition-transform duration-150 ${props.m.open() ? "rotate-90 text-fg-muted" : ""}`}
        />
      </Show>
    </div>
  );
}
