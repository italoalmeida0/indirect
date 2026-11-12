import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { transformAsync } from "@babel/core";
import tsPreset from "@babel/preset-typescript";
import solidPreset from "babel-preset-solid";
import type { PendingApproval } from "../web/src/indirect-code/types";

interface RenderApprovalOpts {
  approval: PendingApproval | null;
  convWidthClass?: string;
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
                        setYoloMode={() => {}}
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

  test("bash renders 1:1 lane alignment, whisper-quiet header, ShellCmd syntax highlight, Arguments disclosure & neutral Always allow", () => {
    const html = renderApprovalCardSsr({
      convWidthClass: "max-w-3xl",
      approval: {
        callId: "call-bash-1",
        tool: "bash",
        args: JSON.stringify({
          command: 'bun test --bail "test/indirect-code-approval-ui.test.ts"',
          description: "Run approval UI unit suite",
        }),
      },
    });

    assertWhisperQuietApprovalHtml(html);
    expect(html).toContain('<section aria-label="Tool approval request" data-approval-card');
    expect(html).toContain('class="max-w-3xl mx-auto border-t border-border/70 px-3 py-2.5"');
    expect(html).toContain('class="rounded-xl border border-border/80 bg-surface overflow-hidden"');
    expect(html).toContain('data-glyph="lucide:shield-alert"');
    expect(html).toContain(">Review tool call<");
    expect(html).toContain(">bash<");
    expect(html).toContain(">Safe mode<");
    expect(html).toContain("Run approval UI unit suite");
    expect(html).toContain("$ ");
    expect(html).toContain("--bail");
    expect(html).toContain("Moves to the background automatically after 10s.");
    expect(html).toContain('data-glyph="lucide:chevron-right"');
    expect(html).toContain(">Arguments<");

    // Calm action hierarchy & mobile touch sizing
    expect(html).toContain('data-action="approval-reject"');
    expect(html).toContain('data-action="approval-always"');
    expect(html).toContain('data-rc-tip="Enable Full access and allow all tool calls"');
    expect(html).toContain('aria-label="Always allow (enable Full access)"');
    expect(html).toContain('data-action="approval-once"');
    expect(html).toContain("bg-fg text-background");
    expect(html).toContain("min-h-7 [@media(pointer:coarse)]:min-h-10");

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
      "Legacy Python execution was removed. Reject so the agent rewrites the snippet as JavaScript.",
    );
    expect(pyHtml).toContain('data-action="approval-reject"');
    expect(pyHtml).not.toContain('data-action="approval-always"');
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
    expect(html).toContain("divide-y divide-border/60");

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
