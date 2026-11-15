import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import type { AccessMode, PendingApproval } from "../web/src/indirect-code/types";

interface RenderApprovalOpts {
  approval: PendingApproval | null;
  convWidthClass?: string;
  accessMode?: AccessMode;
  jobs?: Array<{ id: string; label?: string; status: string }>;
}

function assertWhisperQuietApprovalHtml(html: string) {
  expect(html).not.toContain("bg-warning-subtle");
  expect(html).not.toContain("border-warning");
  expect(html).not.toContain("shadow-resting");
  expect(html).not.toContain("w-6 h-6");
  expect(html).not.toContain("h-6 w-6");
  expect(html).not.toContain("break-all");
  expect(html).not.toContain("—");
  expect(html).not.toContain("→");
  expect(html).not.toContain("font-semibold");
  expect(html).not.toContain("font-bold");
}

describe("ApprovalCard SSR rendering & Arc Design System craft invariants", () => {
  let renderApprovalCardSsr: (opts: RenderApprovalOpts) => string;

  beforeAll(async () => {
    const rootDir = join(import.meta.dir, "..");
    const virtualEntryPath = join(rootDir, "web/src/indirect-code/__ssr_approval_ui_entry__.tsx");

    const buildRes = await Bun.build({
      entrypoints: [virtualEntryPath],
      target: "bun",
      format: "esm",
      plugins: [
        {
          name: "solid-ssr-approval-ui",
          setup(build) {
            build.onResolve({ filter: /__ssr_approval_ui_entry__\.tsx$/ }, () => ({
              path: virtualEntryPath,
            }));

            build.onLoad({ filter: /__ssr_approval_ui_entry__\.tsx$/ }, async () => {
              const entryCode = `
                import { renderToString } from "solid-js/web";
                import { BackgroundCtx } from "./ctx";
                import { ApprovalCard } from "./components/ApprovalCard";

                export function renderApprovalCardSsr(opts) {
                  const bg = {
                    sessionJobs: () => opts.jobs || [],
                    tasks: () => opts.jobs || [],
                    runningTasks: () => [],
                    sessionContent: () => "",
                    liveTail: () => "",
                    stop: () => {},
                  };
                  return renderToString(() => (
                    <BackgroundCtx.Provider value={bg}>
                      <ApprovalCard
                        pendingApproval={() => opts.approval}
                        convWidthClass={() => opts.convWidthClass || "max-w-3xl"}
                        respondApproval={() => {}}
                        accessMode={() => opts.accessMode || "ask"}
                      />
                    </BackgroundCtx.Provider>
                  ));
                }
              `;
              const transformed = await transformAsync(entryCode, {
                filename: virtualEntryPath,
                presets: [[solidPreset, { generate: "ssr", hydratable: false }]],
                babelrc: false,
                configFile: false,
              });
              return { contents: transformed?.code ?? entryCode, loader: "js" };
            });

            build.onResolve({ filter: /^virtual:icons$/ }, () => ({
              path: "virtual:icons",
              namespace: "virtual-icons",
            }));
            build.onLoad({ filter: /.*/, namespace: "virtual-icons" }, () => ({
              contents: `
                export const registry = new Proxy({}, {
                  get(_target, prop) {
                    if (typeof prop !== "string") return undefined;
                    return { width: 24, height: 24, body: '<g data-glyph="' + prop + '"></g>' };
                  }
                });
                export const icons = registry;
                export default registry;
              `,
              loader: "js",
            }));

            build.onLoad({ filter: /\.css$/ }, () => ({
              contents: "",
              loader: "js",
            }));

            build.onLoad({ filter: /\.(js|ts)x$/ }, async (args) => {
              if (args.path.endsWith("__ssr_approval_ui_entry__.tsx")) {
                return undefined;
              }
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
      throw new Error(
        `Failed to bundle SSR approval UI harness: ${JSON.stringify(buildRes.logs)}`,
      );
    }
    const jsText = await buildRes.outputs[0]!.text();
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(jsText, "utf8").toString("base64")}`
    );
    renderApprovalCardSsr = mod.renderApprovalCardSsr;
  });

  test("renders nothing when pendingApproval is null", () => {
    const html = renderApprovalCardSsr({ approval: null });
    expect(html).toBe("");
  });

  test("bash renders 1:1 lane alignment, whisper-quiet header, ShellCmd syntax highlight, Arguments disclosure & scoped buttons", () => {
    const html = renderApprovalCardSsr({
      convWidthClass: "max-w-3xl",
      accessMode: "ask",
      approval: {
        callId: "call-bash-1",
        tool: "bash",
        args: JSON.stringify({
          command: 'bun test --bail "test/indirect-code-approval-ui.test.ts"',
          description: "Run approval UI unit suite",
        }),
        proposedRule: {
          id: "rule-bun-test",
          effect: "allow",
          kind: "exec",
          pattern: "bun test",
        },
        canAllowSession: true,
        canAllowAlways: true,
      },
    });

    assertWhisperQuietApprovalHtml(html);
    expect(html).toContain('<section aria-label="Tool approval request" data-approval-card');
    expect(html).toContain('class="w-full max-w-3xl mx-auto py-1"');
    expect(html).toContain('class="rounded-panel border border-border bg-surface overflow-hidden"');
    expect(html).toContain('data-glyph="lucide:shield-alert"');
    expect(html).toContain(">Review tool call<");
    expect(html).toContain(">bash<");
    expect(html).toContain("Supervised · Ask");
    expect(html).toContain("Run approval UI unit suite");
    expect(html).toContain("$ ");
    expect(html).toContain("--bail");
    expect(html).toContain("Moves to the background automatically after 10s.");
    expect(html).toContain('data-glyph="lucide:chevron-right"');
    expect(html).toContain(">Arguments<");

    // Calm action hierarchy & mobile touch sizing
    expect(html).toContain('data-action="approval-deny"');
    expect(html).toContain('data-action="approval-always"');
    expect(html).toContain('data-rc-tip="Save global allow rule in Settings -> Permissions"');
    expect(html).toContain('aria-label="Always allow"');
    expect(html).toContain('data-action="approval-session"');
    expect(html).toContain('aria-label="Allow for session"');
    expect(html).toContain('data-action="approval-once"');
    expect(html).toContain("bg-fg text-background");
    expect(html).toContain("min-h-7");

    // Verify Always allow button itself carries zero warning classes
    const alwaysBtnMatch = html.match(/<button[^>]*data-action="approval-always"[^>]*>/);
    expect(alwaysBtnMatch).not.toBeNull();
    expect(alwaysBtnMatch![0]).not.toContain("warning");

    // Multi-line bash falls back to clean <pre> with $ prompt prefix and break-words
    const multiHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-bash-2",
        tool: "bash",
        args: JSON.stringify({ command: "git status -sb\ngit diff --stat" }),
      },
    });
    assertWhisperQuietApprovalHtml(multiHtml);
    expect(multiHtml).toContain("git status -sb\ngit diff --stat");
    expect(multiHtml).toContain("whitespace-pre-wrap break-words");
  });

  test("exec_script renders JS metadata pills while legacy python hides Allow buttons and avoids em dashes", () => {
    const jsHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-js",
        tool: "exec_script",
        args: JSON.stringify({
          code: "console.log(process.version);",
          work_dir: "/workspace/app",
          env: { NODE_ENV: "test", CI: "1" },
          stdin: "hello",
        }),
        canAllowSession: true,
        canAllowAlways: true,
      },
    });
    assertWhisperQuietApprovalHtml(jsHtml);
    expect(jsHtml).toContain("Run JavaScript");
    expect(jsHtml).toContain('data-glyph="mdi:language-javascript"');
    expect(jsHtml).toContain("console.log(process.version);");
    expect(jsHtml).toContain(">cwd<");
    expect(jsHtml).toContain("/workspace/app");
    expect(jsHtml).toContain("NODE_ENV=test CI=1");
    expect(jsHtml).toContain(">stdin<");
    expect(jsHtml).toContain("Moves to the background automatically after 10s.");
    expect(jsHtml).toContain('data-action="approval-always"');
    expect(jsHtml).toContain('data-action="approval-session"');
    expect(jsHtml).toContain('data-action="approval-once"');

    const pyHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-py",
        tool: "python",
        args: JSON.stringify({ script: "import sys\nprint(sys.version)" }),
      },
    });
    assertWhisperQuietApprovalHtml(pyHtml);
    expect(pyHtml).toContain("Unsupported legacy Python call");
    expect(pyHtml).toContain('data-glyph="mdi:language-python"');
    expect(pyHtml).toContain(
      "Legacy Python execution was removed. Deny so the agent rewrites the snippet as JavaScript.",
    );
    expect(pyHtml).toContain('data-action="approval-deny"');
    expect(pyHtml).not.toContain('data-action="approval-always"');
    expect(pyHtml).not.toContain('data-action="approval-session"');
    expect(pyHtml).not.toContain('data-action="approval-once"');

    const legacyExecPyHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-exec-py",
        tool: "exec_script",
        args: JSON.stringify({ legacy_lang: "python3", code: "print(42)" }),
      },
    });
    assertWhisperQuietApprovalHtml(legacyExecPyHtml);
    expect(legacyExecPyHtml).toContain("Unsupported legacy Python call");
    expect(legacyExecPyHtml).not.toContain('data-action="approval-once"');
  });

  test("renders dynamic capability callouts, proposed rule scope chips, High risk vs Auto badges, and non-persistable button gating", () => {
    // 1. High-risk Auto command prompt (git push)
    const highRiskHtml = renderApprovalCardSsr({
      accessMode: "auto",
      approval: {
        callId: "call-push-1",
        tool: "bash",
        args: JSON.stringify({ command: "git push origin main" }),
        capability: "exec",
        target: "git push origin main",
        reason: "Pushing commits to a remote repository modifies external state.",
        risk: "high",
        accessMode: "auto",
        proposedRule: {
          id: "rule-push",
          effect: "allow",
          kind: "exec",
          pattern: "git push",
        },
        canAllowSession: true,
        canAllowAlways: true,
      },
    });
    assertWhisperQuietApprovalHtml(highRiskHtml);
    expect(highRiskHtml).toContain(">Review permission request<");
    expect(highRiskHtml).toContain('data-approval-badge="high-risk"');
    expect(highRiskHtml).toContain("High risk");
    expect(highRiskHtml).toContain('data-approval-callout');
    expect(highRiskHtml).toContain('data-approval-capability="exec"');
    expect(highRiskHtml).toContain(">Command<");
    expect(highRiskHtml).toContain("git push origin main");
    expect(highRiskHtml).toContain(
      "Pushing commits to a remote repository modifies external state.",
    );
    expect(highRiskHtml).toContain('data-approval-scope');
    expect(highRiskHtml).toContain('Scope: allow command "git push"');
    expect(highRiskHtml).toContain('data-action="approval-deny"');
    expect(highRiskHtml).toContain('data-action="approval-always"');
    expect(highRiskHtml).toContain('data-action="approval-session"');
    expect(highRiskHtml).toContain('data-action="approval-once"');

    // 2. Medium-risk Auto runtime network boundary check
    const netHtml = renderApprovalCardSsr({
      accessMode: "auto",
      approval: {
        callId: "call-net-1",
        tool: "exec_script",
        args: JSON.stringify({ code: "await fetch('https://api.github.com/repos');" }),
        capability: "net",
        target: "api.github.com:443",
        reason: "Script requested network access to api.github.com:443.",
        risk: "medium",
        accessMode: "auto",
        proposedRule: {
          id: "rule-gh",
          effect: "allow",
          kind: "net",
          pattern: "api.github.com",
        },
        canAllowSession: true,
        canAllowAlways: true,
      },
    });
    assertWhisperQuietApprovalHtml(netHtml);
    expect(netHtml).toContain(">Review permission request<");
    expect(netHtml).toContain('data-approval-badge="auto"');
    expect(netHtml).toContain("Auto · Boundary check");
    expect(netHtml).toContain(">Network access<");
    expect(netHtml).toContain("api.github.com:443");
    expect(netHtml).toContain('Scope: allow host "api.github.com"');

    // 3. Outside path write & protected file read badges
    const fsWriteHtml = renderApprovalCardSsr({
      accessMode: "auto",
      approval: {
        callId: "call-write-out",
        tool: "write",
        args: JSON.stringify({ path: "../shared-lib/index.ts", content: "export {};\n" }),
        capability: "fs_write",
        target: "../shared-lib/index.ts",
        reason: "Target path is outside the active workspace root.",
        proposedRule: {
          id: "rule-shared",
          effect: "allow",
          kind: "fs_write",
          pattern: "../shared-lib/**",
        },
        canAllowSession: true,
        canAllowAlways: false,
      },
    });
    assertWhisperQuietApprovalHtml(fsWriteHtml);
    expect(fsWriteHtml).toContain(">Write file<");
    expect(fsWriteHtml).toContain('Scope: allow path "../shared-lib/**"');
    expect(fsWriteHtml).toContain('data-action="approval-session"');
    expect(fsWriteHtml).not.toContain('data-action="approval-always"');

    const secretReadHtml = renderApprovalCardSsr({
      accessMode: "auto",
      approval: {
        callId: "call-secret",
        tool: "read",
        args: JSON.stringify({ path: ".env.production" }),
        capability: "fs_read",
        target: ".env.production",
        reason: "Reading protected secret file .env.production.",
        canAllowSession: false,
        canAllowAlways: false,
      },
    });
    assertWhisperQuietApprovalHtml(secretReadHtml);
    expect(secretReadHtml).toContain(">Protected file<");
    expect(secretReadHtml).toContain('data-action="approval-deny"');
    expect(secretReadHtml).toContain('data-action="approval-once"');
    expect(secretReadHtml).not.toContain('data-action="approval-session"');
    expect(secretReadHtml).not.toContain('data-action="approval-always"');
    expect(secretReadHtml).not.toContain("data-approval-scope");
  });

  test("read renders FileIcon, path, and line-range chip (L10-50 and L10+), and hides Arguments when empty", () => {
    const rangeHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-read-1",
        tool: "read",
        args: JSON.stringify({ path: "web/src/ui.tsx", offset: 10, limit: 41 }),
      },
    });
    assertWhisperQuietApprovalHtml(rangeHtml);
    expect(rangeHtml).toContain('data-glyph="mdi:react"');
    expect(rangeHtml).toContain(">Read<");
    expect(rangeHtml).toContain("web/src/ui.tsx");
    expect(rangeHtml).toContain(">L10-50<");

    const openRangeHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-read-2",
        tool: "read",
        args: JSON.stringify({ path: "server/index.ts", offset: 10 }),
      },
    });
    assertWhisperQuietApprovalHtml(openRangeHtml);
    expect(openRangeHtml).toContain('data-glyph="mdi:language-typescript"');
    expect(openRangeHtml).toContain(">L10+<");

    const emptyArgsHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-empty",
        tool: "bg_list",
        args: "{}",
      },
    });
    assertWhisperQuietApprovalHtml(emptyArgsHtml);
    expect(emptyArgsHtml).not.toContain("<details");
    expect(emptyArgsHtml).not.toContain(">Arguments<");
  });

  test("write renders line count chip and truncates content preview past 12 lines with +N more lines", () => {
    const lines = Array.from({ length: 15 }, (_, idx) => `const line${idx + 1} = ${idx + 1};`);
    const html = renderApprovalCardSsr({
      approval: {
        callId: "call-write-1",
        tool: "write",
        args: JSON.stringify({
          path: "src/generated/constants.ts",
          content: lines.join("\n"),
        }),
      },
    });

    assertWhisperQuietApprovalHtml(html);
    expect(html).toContain(">Create<");
    expect(html).toContain("src/generated/constants.ts");
    expect(html).toContain(">15 lines<");
    expect(html).toContain("const line1 = 1;");
    expect(html).toContain("const line12 = 12;");
    // Preview surface stops at line 12 (before the <details> raw Arguments block)
    const beforeDetails = html.split("<details")[0]!;
    expect(beforeDetails).not.toContain("const line13 = 13;");
    expect(beforeDetails).toContain('data-action="approval-expand-write"');
    expect(beforeDetails).toContain("+3 more lines");
  });

  test("edit renders multi-hunk diff with explicit -/+ gutter markers, hunk dividers, and +N more changes", () => {
    const html = renderApprovalCardSsr({
      approval: {
        callId: "call-edit-1",
        tool: "edit",
        args: JSON.stringify({
          path: "web/src/indirect-code/components/ApprovalCard.tsx",
          edits: [
            { old_text: "const legacy = true;", new_text: "const legacy = false;" },
            { old_text: "const retries = 1;", new_text: "const retries = 3;" },
            { old_text: "third_old", new_text: "third_new" },
          ],
        }),
      },
    });

    assertWhisperQuietApprovalHtml(html);
    expect(html).toContain(">Edit<");
    expect(html).toContain(">3 changes<");
    expect(html).toContain("divide-y divide-border-subtle");

    const beforeDetails = html.split("<details")[0]!;
    const hunkMatches = beforeDetails.match(/data-edit-hunk/g) ?? [];
    expect(hunkMatches).toHaveLength(2);
    expect(beforeDetails).toContain("bg-danger-subtle/40 text-fg");
    expect(beforeDetails).toContain("bg-success-subtle/40 text-fg");
    expect(beforeDetails).toContain("select-none shrink-0 w-4 text-danger");
    expect(beforeDetails).toContain("select-none shrink-0 w-4 text-success");
    expect(beforeDetails).toContain(">-<");
    expect(beforeDetails).toContain(">+<");
    expect(beforeDetails).toContain("const legacy = true;");
    expect(beforeDetails).toContain("const legacy = false;");
    expect(beforeDetails).not.toContain("third_old");
    expect(beforeDetails).toContain('data-action="approval-expand-edits"');
    expect(beforeDetails).toContain("+1 more changes");

    const singleHunkHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-edit-2",
        tool: "edit",
        args: JSON.stringify({
          path: "server/config.ts",
          old_text: "timeoutMs = 5000;",
          new_text: "timeoutMs = 10000;",
        }),
      },
    });
    assertWhisperQuietApprovalHtml(singleHunkHtml);
    expect(singleHunkHtml).toContain(">1 change<");
    expect(singleHunkHtml).toContain("timeoutMs = 5000;");
    expect(singleHunkHtml).toContain("timeoutMs = 10000;");
    expect(singleHunkHtml).not.toContain("more changes");
  });

  test("todo renders StatusBanners-matching status icons without raw in progress strings", () => {
    const html = renderApprovalCardSsr({
      approval: {
        callId: "call-todo-1",
        tool: "todo",
        args: JSON.stringify({
          items: [
            { id: "1", text: "Audit existing card", status: "completed" },
            { id: "2", text: "Upgrade ApprovalCard layout", status: "in_progress" },
            { id: "3", text: "Run verification suite", status: "pending" },
          ],
        }),
      },
    });

    assertWhisperQuietApprovalHtml(html);
    expect(html).toContain("Update task plan");
    expect(html).toContain(">3 tasks<");
    expect(html).toContain('data-todo-status="completed"');
    expect(html).toContain('data-todo-status="in_progress"');
    expect(html).toContain('data-todo-status="pending"');
    expect(html).toContain('data-glyph="lucide:circle-check"');
    expect(html).toContain('data-glyph="lucide:circle-dot"');
    expect(html).toContain('data-glyph="lucide:circle"');
    expect(html).toContain("line-through");

    const beforeDetails = html.split("<details")[0]!;
    expect(beforeDetails).not.toContain("in progress");
  });

  test("bg_await, bg_cancel, glob, and fallback tools (fetch_url, use_skill) surface crisp inline targets", () => {
    const awaitHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-await",
        tool: "bg_await",
        args: JSON.stringify({ max_wait_seconds: 45, reason: "Waiting for daemon test binary" }),
      },
    });
    assertWhisperQuietApprovalHtml(awaitHtml);
    expect(awaitHtml).toContain('data-glyph="lucide:timer"');
    expect(awaitHtml).toContain(">Wait<");
    expect(awaitHtml).toContain("45s");
    expect(awaitHtml).toContain("Waiting for daemon test binary");

    const cancelHtml = renderApprovalCardSsr({
      jobs: [{ id: "job-99", label: "bun run build:web", status: "running" }],
      approval: {
        callId: "call-cancel",
        tool: "bg_cancel",
        args: JSON.stringify({ job_id: "job-99" }),
      },
    });
    assertWhisperQuietApprovalHtml(cancelHtml);
    expect(cancelHtml).toContain('data-glyph="lucide:octagon-x"');
    expect(cancelHtml).toContain(">Stop background task<");
    expect(cancelHtml).toContain("bun run build:web");

    const globHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-glob",
        tool: "glob",
        args: JSON.stringify({ pattern: "web/src/**/*.tsx", path: "web" }),
      },
    });
    assertWhisperQuietApprovalHtml(globHtml);
    expect(globHtml).toContain('data-glyph="lucide:search"');
    expect(globHtml).toContain(">Search files<");
    expect(globHtml).toContain("web/src/**/*.tsx");

    const fetchHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-fetch",
        tool: "fetch_url",
        args: JSON.stringify({ url: "https://api.example.com/v1/health", method: "GET" }),
      },
    });
    assertWhisperQuietApprovalHtml(fetchHtml);
    const fetchPreview = fetchHtml.split("<details")[0]!;
    expect(fetchPreview).toContain('data-glyph="lucide:globe"');
    expect(fetchPreview).toContain(">fetch_url<");
    expect(fetchPreview).toContain("https://api.example.com/v1/health");

    const skillHtml = renderApprovalCardSsr({
      approval: {
        callId: "call-skill",
        tool: "use_skill",
        args: JSON.stringify({ skill: "generative_ui_agentic" }),
      },
    });
    assertWhisperQuietApprovalHtml(skillHtml);
    const skillPreview = skillHtml.split("<details")[0]!;
    expect(skillPreview).toContain(">use_skill<");
    expect(skillPreview).toContain("generative_ui_agentic");
  });
});

describe("Brand wordmark & Settings section-jump consistency", () => {
  test("all brand surfaces use JetBrains Mono brand-wordmark / /indirect-icon.svg and Settings jump pills stay icon-free", async () => {
    const root = join(import.meta.dir, "..");
    const [
      shellCss,
      componentsCss,
      indexSrc,
      sidebarSrc,
      brandSrc,
      loginSrc,
      setPwSrc,
      chromeSrc,
      settingsModalSrc,
    ] = await Promise.all([
      readFile(join(root, "web/src/styles/shell.css"), "utf8"),
      readFile(join(root, "web/src/ds/components.css"), "utf8"),
      readFile(join(root, "web/src/index.tsx"), "utf8"),
      readFile(join(root, "web/src/indirect-code/components/WorkspaceSidebar.tsx"), "utf8"),
      readFile(join(root, "web/src/indirect-code/components/IndirectBrand.tsx"), "utf8"),
      readFile(join(root, "web/src/pages/Login.tsx"), "utf8"),
      readFile(join(root, "web/src/pages/SetPassword.tsx"), "utf8"),
      readFile(join(root, "web/src/chrome.tsx"), "utf8"),
      readFile(join(root, "web/src/indirect-code/modals/SettingsModal.tsx"), "utf8"),
    ]);

    expect(shellCss).toMatch(/\.brand-wordmark\s*\{[^}]*font-family:\s*var\(--font-code\)/);
    expect(shellCss).toMatch(/\.brand-wordmark\s*\{[^}]*font-weight:\s*600/);
    expect(shellCss).toMatch(/\.brand-wordmark\s*\{[^}]*text-transform:\s*uppercase/);
    expect(componentsCss).toMatch(/\.rc-brand-name\s*\{[^}]*font-family:\s*var\(--font-code\)/);

    expect(indexSrc).toContain('{ path: "/code", label: "Indirect Code", icon: "indirect-code" }');
    expect(indexSrc.match(/brand-wordmark[^\n]*>INDIRECT GATEWAY</g)?.length).toBe(3);
    expect(sidebarSrc).toMatch(/brand-wordmark[\s\S]*?>\s*INDIRECT CODE\s*</);
    expect(brandSrc).toContain(">INDIRECT<");
    expect(loginSrc).toMatch(/brand-wordmark[\s\S]*?>\s*INDIRECT\s*</);
    expect(setPwSrc).toMatch(/brand-wordmark[\s\S]*?>\s*INDIRECT\s*</);
    expect(chromeSrc).toContain('src="/indirect-icon.svg"');

    const navBlock = settingsModalSrc.split('aria-label="Settings sections"')[1]?.split("</nav>")[0] ?? "";
    expect(navBlock).toContain('label: "Permissions"');
    expect(navBlock).not.toContain("lucide:");
    expect(navBlock).not.toContain("<Iconify");
  });
});
