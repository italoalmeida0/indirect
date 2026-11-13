import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { readFileSync as readFileSyncFs } from "fs";
import { join } from "path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import { createRoot } from "solid-js";
import type { ToastItem, ToastKind } from "../web/src/ds/components/toast";
import { createTurnNotify, turnNotifyText } from "../web/src/indirect-code/hooks/useTurnNotify";
import { createTranscript } from "../web/src/indirect-code/hooks/useTranscript";

const ROOT = join(import.meta.dir, "..");

interface BundledToastHarness {
  pushToast: (text: string, kind?: ToastKind) => void;
  activeToasts: () => readonly ToastItem[];
  clearToasts: () => void;
  toastDuration: (kind: ToastKind) => number;
  createNotice: () => {
    appNotice: () => { message: string; kind: ToastKind } | null;
    setAppNotice: (next: { message: string; kind: ToastKind } | null) => void;
    toast: (message: string, kind?: ToastKind) => void;
  };
  renderStatusBannersSsr: (opts: {
    activeSessionId?: string;
    draftMode?: boolean;
    sessionStatus?: "idle" | "running";
    turnActivity?: { startedAt: number; endedAt?: number; status: string } | null;
    turnLabel?: string;
    turnHint?: string;
    compactingText?: string;
  }) => string;
}

let harness: BundledToastHarness;

beforeAll(async () => {
  const virtualEntryPath = join(ROOT, "web/src/indirect-code/__ssr_toast_overhaul_entry__.tsx");
  const entryCode = `
    import { renderToString } from "solid-js/web";
    import {
      pushToast,
      activeToasts,
      clearToasts,
      toastDuration,
    } from "../ds/components/toast";
    import { createNotice } from "./hooks/useNotice";
    import { RemoteCodeProvider } from "./ctx";
    import { StatusBanners } from "./components/composer/StatusBanners";

    export { pushToast, activeToasts, clearToasts, toastDuration, createNotice };

    export function renderStatusBannersSsr(opts: {
      activeSessionId?: string;
      draftMode?: boolean;
      sessionStatus?: "idle" | "running";
      turnActivity?: { startedAt: number; endedAt?: number; status: string } | null;
      turnLabel?: string;
      turnHint?: string;
      compactingText?: string;
    }): string {
      const notice = createNotice();
      notice.toast("Floating only, never inline", "err");
      clearToasts();

      const session: any = {
        activeSessionId: () => opts.activeSessionId ?? "s1",
        draftMode: () => opts.draftMode ?? false,
        workspaceBlocked: () => false,
      };
      const transcript: any = {
        sessionStatus: () => opts.sessionStatus ?? "idle",
        turnActivity: () => opts.turnActivity ?? null,
        turnLabel: () => opts.turnLabel ?? "",
        turnHint: () => opts.turnHint ?? "",
        compactingText: () => opts.compactingText ?? "",
        todos: () => [],
        todosOpen: () => false,
        toggleTodosOpen: () => {},
      };
      const host: any = {
        activeHost: () => ({ id: "h1", name: "Mac", status: "online" }),
        connectionState: () => "connected",
        loadHosts: () => {},
      };
      const ui: any = {
        ...notice,
        composerCollapsed: () => false,
        toggleComposerCollapsed: () => {},
      };
      return renderToString(() => (
        <RemoteCodeProvider
          host={host}
          session={session}
          transcript={transcript}
          turnChanges={{} as any}
          composer={{} as any}
          queue={{} as any}
          background={{} as any}
          modal={{} as any}
          ui={ui}
        >
          <StatusBanners />
        </RemoteCodeProvider>
      ));
    }
  `;

  const buildRes = await Bun.build({
    entrypoints: [virtualEntryPath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "solid-ssr-toast-harness",
        setup(build) {
          build.onResolve({ filter: /__ssr_toast_overhaul_entry__\.tsx$/ }, () => ({
            path: virtualEntryPath,
          }));
          build.onLoad({ filter: /__ssr_toast_overhaul_entry__\.tsx$/ }, async () => {
            const out = await transformAsync(entryCode, {
              filename: virtualEntryPath,
              presets: [
                [solidPreset, { generate: "ssr", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? entryCode, loader: "js" };
          });
          build.onResolve({ filter: /^virtual:icons$/ }, () => ({
            path: "virtual:icons",
            namespace: "virtual-icons",
          }));
          build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
            contents: "export const registry = {}; export const icons = {}; export default registry;",
            loader: "js",
          }));
          build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
          build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
            if (args.path.endsWith("__ssr_toast_overhaul_entry__.tsx")) return undefined;
            const code = await readFile(args.path, "utf8");
            const out = await transformAsync(code, {
              filename: args.path,
              presets: [
                [solidPreset, { generate: "ssr", hydratable: false }],
                [tsPreset, { isTSX: true, allExtensions: true }],
              ],
              sourceMaps: false,
              babelrc: false,
              configFile: false,
            });
            return { contents: out?.code ?? code, loader: "js" };
          });
        },
      },
    ],
  });

  if (!buildRes.success || buildRes.outputs.length === 0) {
    throw new Error(`Failed to bundle toast overhaul SSR harness: ${JSON.stringify(buildRes.logs)}`);
  }
  const jsText = await buildRes.outputs[0]!.text();
  harness = (await import(
    `data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`
  )) as BundledToastHarness;
});

describe("DS Toast stack & useNotice unification", () => {
  test("pushToast deduplicates identical (kind, text) in place, ignores blanks, and caps stack at 3", () => {
    harness.clearToasts();
    expect(harness.toastDuration("ok")).toBe(3200);
    expect(harness.toastDuration("err")).toBe(6500);

    // Blank strings are ignored
    harness.pushToast("");
    harness.pushToast("   ");
    expect(harness.activeToasts()).toHaveLength(0);

    // Identical (kind, text) updates rev in place without duplicating or remounting
    harness.pushToast("Settings saved on the host", "ok");
    const firstRef = harness.activeToasts()[0]!;
    expect(firstRef.rev).toBe(1);

    harness.pushToast("Settings saved on the host", "ok");
    expect(harness.activeToasts()).toHaveLength(1);
    expect(harness.activeToasts()[0]).toBe(firstRef);
    expect(firstRef.rev).toBe(2);

    // Different kind with same text creates a distinct item
    harness.pushToast("Settings saved on the host", "err");
    expect(harness.activeToasts()).toHaveLength(2);
    expect(harness.activeToasts()[1]!.kind).toBe("err");
    expect(harness.activeToasts()[1]!.rev).toBe(1);

    // Visible stack caps at 3 items
    harness.pushToast("Third notice", "ok");
    harness.pushToast("Fourth notice", "err");
    const stack = harness.activeToasts();
    expect(stack).toHaveLength(3);
    expect(stack.map((item) => item.text)).toEqual([
      "Settings saved on the host",
      "Third notice",
      "Fourth notice",
    ]);
    expect(stack[0]!.kind).toBe("err");

    harness.clearToasts();
    expect(harness.activeToasts()).toHaveLength(0);
  });

  test("createNotice().toast delegates directly to pushToast while appNotice stays null", () => {
    harness.clearToasts();
    const notice = harness.createNotice();
    expect(notice.appNotice()).toBeNull();

    notice.toast("Daemon returned an error", "err");
    expect(notice.appNotice()).toBeNull();
    expect(harness.activeToasts()).toHaveLength(1);
    expect(harness.activeToasts()[0]).toMatchObject({
      text: "Daemon returned an error",
      kind: "err",
      rev: 1,
    });

    // Repeat via notice.toast deduplicates in place
    notice.toast("Daemon returned an error", "err");
    expect(harness.activeToasts()).toHaveLength(1);
    expect(harness.activeToasts()[0]!.rev).toBe(2);

    harness.clearToasts();
  });

  test("CSS and component contracts anchor top-right / mobile below header with bare icon and dismiss attrs", async () => {
    const css = await readFile(join(ROOT, "web/src/ds/components.css"), "utf8");
    expect(css).toContain("top: max(0.875rem, calc(var(--sat) + 0.5rem));");
    expect(css).toContain("bottom: auto;");
    expect(css).toContain("top: max(3.25rem, calc(var(--sat) + 2.75rem));");
    expect(css).toContain("border-radius: 0.75rem;");
    expect(css).not.toMatch(/\.ui-toast-(?:ok|err)\s+\.ui-toast-icon\s*\{[^}]*background:\s*var\(--(?:success|danger)-subtle\)/);

    const toastSrc = readFileSyncFs(join(ROOT, "web/src/ds/components/toast.tsx"), "utf8");
    expect(toastSrc).toContain('aria-label="Dismiss notification"');
    expect(toastSrc).toContain('data-tip="Dismiss"');
    expect(toastSrc).toContain("translateY(-8px) scale(0.985)");

    const settingsModalSrc = readFileSyncFs(
      join(ROOT, "web/src/indirect-code/modals/SettingsModal.tsx"),
      "utf8",
    );
    expect(settingsModalSrc).not.toContain("appNotice");
    expect(settingsModalSrc).not.toContain("useUI");
  });
});

describe("useTurnNotify foreground suppression & background fallback", () => {
  test("keeps turnNotifyText unchanged while suppressing fallback toast on visible active session", async () => {
    // 1. turnNotifyText contract for OS / Web Push notifications is 100% preserved
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "done" })).toEqual({
      title: "Turn finished — Fix bug",
      body: "Mac · tap to open",
    });
    expect(turnNotifyText({ title: "Fix bug", hostName: "Mac", disposition: "approval" })).toEqual({
      title: "Approval needed — Fix bug",
      body: "Mac · tap to open",
    });

    const prevNotification = (globalThis as any).Notification;
    const prevDocument = (globalThis as any).document;
    try {
      delete (globalThis as any).Notification;
      let visibilityState: "visible" | "hidden" = "visible";
      (globalThis as any).document = {
        get visibilityState() {
          return visibilityState;
        },
      };

      let fgHost = "h1";
      let fgSession = "s1";
      const toasts: { message: string; kind: string }[] = [];

      const notify = createTurnNotify({
        hosts: () => [
          { id: "h1", name: "Mac", hostname: "mac", os: "darwin", arch: "arm64", userId: "u", apiKeyId: null, status: "online", lastSeenAt: null, createdAt: 0 },
          { id: "h2", name: "Linux", hostname: "box", os: "linux", arch: "amd64", userId: "u", apiKeyId: null, status: "online", lastSeenAt: null, createdAt: 0 },
        ],
        sessions: () => [
          { id: "s1", title: "Active chat" },
          { id: "s2", title: "Background chat" },
        ],
        toast: (message, kind = "ok") => toasts.push({ message, kind }),
        onOpenSession: () => {},
        activeHostId: () => fgHost,
        activeSessionId: () => fgSession,
      });

      // Active foreground session in visible tab: suppressed across done, approval, and question
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s1", status: "running" });
      notify.noteMessage({ type: "tool_approval_request", hostId: "h1", sessionId: "s1", callId: "c1", tool: "bash", args: {} });
      notify.noteMessage({ type: "question_request", hostId: "h1", sessionId: "s1", question: { id: "q1" } });
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s1", status: "idle" });
      expect(toasts).toHaveLength(0);

      // Background session on same host: fires clean fallback toast without em-dash or "tap to open"
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s2", status: "running" });
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s2", status: "idle" });
      expect(toasts).toEqual([{ message: "Turn finished: Background chat", kind: "ok" }]);
      expect(toasts[0]!.message).not.toContain("—");
      expect(toasts[0]!.message).not.toContain("tap to open");

      // Background host: fires clean fallback toast
      toasts.length = 0;
      notify.noteMessage({ type: "tool_approval_request", hostId: "h2", sessionId: "s1", callId: "c2", tool: "bash", args: {} });
      expect(toasts).toEqual([{ message: "Approval needed: Active chat", kind: "ok" }]);

      // Foreground session when tab is hidden: fires clean fallback toast
      toasts.length = 0;
      visibilityState = "hidden";
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s1", status: "running" });
      notify.noteMessage({ type: "agent_event", hostId: "h1", sessionId: "s1", event: { type: "turn_end", error: "Quota exceeded" } });
      notify.noteMessage({ type: "session_status", hostId: "h1", sessionId: "s1", status: "idle" });
      expect(toasts).toEqual([{ message: "Turn failed: Active chat", kind: "err" }]);

      // Manual testNotify() always fires fallback when Notification is unavailable
      toasts.length = 0;
      visibilityState = "visible";
      fgHost = "test";
      fgSession = "test";
      notify.testNotify();
      await Promise.resolve();
      await Promise.resolve();
      expect(toasts).toEqual([{ message: "Turn finished: Test conversation", kind: "ok" }]);

      // Denied permission does not emit a duplicate error toast over Settings inline alert
      toasts.length = 0;
      (globalThis as any).Notification = class {
        static permission = "denied";
      };
      notify.testNotify();
      await Promise.resolve();
      await Promise.resolve();
      expect(toasts).toHaveLength(0);
    } finally {
      if (prevNotification === undefined) delete (globalThis as any).Notification;
      else (globalThis as any).Notification = prevNotification;
      if (prevDocument === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDocument;
    }
  });
});

describe("StatusBanners & useTranscript compaction status without inline appNotice", () => {
  test("StatusBanners renders Compacting older context… in data-turn-status without inline appNotice slab", () => {
    // Manual /compact while sessionStatus is idle (even with no turnActivity)
    const manualHtml = harness.renderStatusBannersSsr({
      activeSessionId: "s1",
      sessionStatus: "idle",
      turnActivity: null,
      turnLabel: "Compacting older context…",
      compactingText: "Compacting older context…",
    });
    expect(manualHtml).toContain("data-turn-status");
    expect(manualHtml).toContain("Compacting older context…");
    expect(manualHtml).toContain('data-indicator="neural-matrix"');
    expect(manualHtml).toContain("ui-shimmer");
    expect(manualHtml).not.toContain("animate-spin");
    expect(manualHtml).not.toContain("Floating only, never inline");
    expect(manualHtml).not.toContain('aria-label="Dismiss notification"');

    // Idle conversation without compaction hides data-turn-status
    const idleHtml = harness.renderStatusBannersSsr({
      activeSessionId: "s1",
      sessionStatus: "idle",
      turnActivity: null,
      turnLabel: "",
      compactingText: "",
    });
    expect(idleHtml).not.toContain("data-turn-status");
    expect(idleHtml).not.toContain('aria-label="Dismiss notification"');
  });

  test("createTranscript tracks compact_progress in turnLabel without toasting and clears on completion or reset", async () => {
    const prevRaf = (globalThis as any).requestAnimationFrame;
    const prevCaf = (globalThis as any).cancelAnimationFrame;
    const prevDoc = (globalThis as any).document;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0);
    (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
    (globalThis as any).document = {
      hidden: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: () => null,
    };
    const toasts: { message: string; kind?: string }[] = [];
    try {
      await createRoot(async (dispose) => {
        try {
          const t = createTranscript({
            send: () => {},
            isOpen: () => true,
            getSessionId: () => "s1",
            getHostId: () => "h1",
            toast: (message, kind) => toasts.push({ message, kind }),
            showChoice: async () => null,
            onTurnIdle: () => {},
            onUsageContext: () => {},
          });

          // Manual /compact when sessionStatus is idle (after a finished turn)
          t.handleAgentEvent("s1", { type: "turn_start" });
          t.handleStatusEvent({ type: "session_status", sessionId: "s1", status: "idle" });
          expect(t.turnLabel()).toContain("Turn completed");

          t.handleAgentEvent("s1", {
            type: "compact_progress",
            text: "Compacting older context…",
          });
          expect(toasts).toHaveLength(0);
          expect(t.compactingText()).toBe("Compacting older context…");
          expect(t.turnLabel()).toBe("Compacting older context…");

          // Clears on session_compacted / applySessionContent with compaction
          await t.applySessionContent("s1", [], { count: 1, keepFrom: 0, previousSummary: "Summary" });
          expect(t.compactingText()).toBe("");
          expect(t.turnLabel()).not.toContain("Compacting older context…");

          // Also clears on resetForSession (session switch)
          t.handleAgentEvent("s1", {
            type: "compact_progress",
            text: "Compacting older context…",
          });
          expect(t.compactingText()).toBe("Compacting older context…");
          t.resetForSession();
          expect(t.compactingText()).toBe("");
          expect(toasts).toHaveLength(0);
        } finally {
          dispose();
        }
      });
    } finally {
      if (prevRaf === undefined) delete (globalThis as any).requestAnimationFrame;
      else (globalThis as any).requestAnimationFrame = prevRaf;
      if (prevCaf === undefined) delete (globalThis as any).cancelAnimationFrame;
      else (globalThis as any).cancelAnimationFrame = prevCaf;
      if (prevDoc === undefined) delete (globalThis as any).document;
      else (globalThis as any).document = prevDoc;
    }
  });
});
