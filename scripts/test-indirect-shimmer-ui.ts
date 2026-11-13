/**
 * Real Chromium frame-by-frame shimmer continuity, DOM-identity, and pixel-contrast gate.
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-shimmer-ui.ts [--contact-sheet <out.png>]
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, promises as fs, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import iconifyPlugin from "../plugins/iconify-solid-plugin";
import solidPlugin from "../plugins/solid-plugin";

function resolveContactSheetPath(): string {
  const idx = process.argv.indexOf("--contact-sheet");
  if (idx >= 0 && process.argv[idx + 1]) return path.resolve(process.argv[idx + 1]!);
  if (process.env.SHIMMER_CONTACT_SHEET) return path.resolve(process.env.SHIMMER_CONTACT_SHEET);
  return "";
}

async function loadPlaywright(): Promise<{ chromium: any }> {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  candidates.push("playwright", "playwright-core");

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    candidates.push(path.join(localAppData, "GG Coder", "sidecar", "node_modules", "playwright", "index.mjs"));
    const npxRoot = path.join(localAppData, "npm-cache", "_npx");
    const npxDirs = await fs.readdir(npxRoot).catch(() => [] as string[]);
    for (const d of npxDirs) {
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright", "index.mjs"));
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright-core", "index.mjs"));
    }
  } else {
    const home = process.env.HOME || homedir();
    candidates.push("/tmp/pw/node_modules/playwright-core/index.mjs");
    const npxRoot = path.join(home, ".npm", "_npx");
    const npxDirs = await fs.readdir(npxRoot).catch(() => [] as string[]);
    for (const d of npxDirs) {
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright", "index.mjs"));
      candidates.push(path.join(npxRoot, d, "node_modules", "playwright-core", "index.mjs"));
    }
  }

  for (const spec of candidates) {
    try {
      const target = path.isAbsolute(spec) ? (existsSync(spec) ? pathToFileURL(spec).href : "") : spec;
      if (!target) continue;
      const mod = await import(target);
      if (mod?.chromium) return mod;
    } catch {
      // Try next candidate.
    }
  }
  console.error("Playwright module not found: set PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs");
  process.exit(2);
}

async function resolveChrome(): Promise<string | undefined> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (process.platform === "win32") {
    const winCache = path.join(process.env.LOCALAPPDATA || "", "ms-playwright");
    const winDirs = (await fs.readdir(winCache).catch(() => [] as string[]))
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse();
    for (const d of winDirs) {
      for (const sub of ["chrome-win64", "chrome-win"]) {
        const cand = path.join(winCache, d, sub, "chrome.exe");
        if (await fs.stat(cand).catch(() => null)) return cand;
      }
    }
    const winSystemBrowsers = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const cand of winSystemBrowsers) {
      if (await fs.stat(cand).catch(() => null)) return cand;
    }
  }
  return undefined;
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(ROOT, "..");
const distDir = path.join(WS, "dist");
const cssName = Array.from(new Bun.Glob("assets/*.css").scanSync(distDir))[0];
if (!cssName) {
  throw new Error("dist/assets/*.css missing — run `bun run build:web` first");
}

const bundle = await Bun.build({
  entrypoints: [path.join(WS, "test", "fixtures", "indirect-shimmer-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));

const worker = await Bun.build({
  entrypoints: [path.join(WS, "web", "src", "indirect-code", "transcript", "history-worker.ts")],
  target: "browser",
});
if (!worker.success) throw new Error(worker.logs.join("\n"));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/bundle.js") return new Response(bundle.outputs[0]);
    if (pathname === "/workers/history-worker.js") return new Response(worker.outputs[0]);
    if (pathname === "/app.css") return new Response(Bun.file(path.join(distDir, cssName)));
    if (pathname.startsWith("/assets/")) {
      const assetPath = path.join(distDir, pathname.slice(1));
      if (existsSync(assetPath)) return new Response(Bun.file(assetPath));
    }
    return new Response(
      '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});

const { chromium } = await loadPlaywright();
const executablePath = await resolveChrome();
const browser = await chromium.launch({ executablePath, headless: true });

interface StripFrame {
  phaseLabel: string;
  dataUrl: string;
  visibleGlyphPixels: number;
  nestedSpanGlyphPixels: number;
  maxContrastDelta: number;
}

try {
  const context = await browser.newContext({
    viewport: { width: 920, height: 760 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(String(e)));

  await page.goto(server.url.toString());
  await page.waitForFunction(() => Boolean((window as any).shimmerUI));
  await page.evaluate(() => document.fonts.ready);

  // -------------------------------------------------------------------------
  // 1. Live Thinking Phase (`Thinking 1s` -> `Thinking 2s` -> `Thinking 3s` + `Working · Ns`)
  //    Sample across 100+ rAF frames while reasoning deltas stream and 1s clocks tick.
  // -------------------------------------------------------------------------
  const thinkingAudit = await page.evaluate(async () => {
    const ui = (window as any).shimmerUI;
    ui.seedThinkingPhase();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const thinkEl = document.querySelector('[data-thinking-row] .ui-shimmer, .ui-shimmer[data-thinking-label]') as HTMLElement | null;
    const workEl = document.querySelector('[data-turn-status] .ui-shimmer') as HTMLElement | null;
    if (!thinkEl || !workEl) {
      throw new Error(`Missing thinking/working shimmer elements: think=${!!thinkEl} work=${!!workEl}`);
    }

    const initialThinkLabel = thinkEl.textContent || "";
    const initialElapsedLabel = document.querySelector("[data-turn-status]")?.textContent || "";
    const thinkSamples: number[] = [];
    const workSamples: number[] = [];
    const labelsSeen = new Set<string>([initialThinkLabel]);

    for (let f = 0; f < 135; f++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (f === 25 || f === 60 || f === 95) {
        ui.t.handleAgentEvent("s-shimmer", {
          type: "reasoning_delta",
          messageId: "a1",
          delta: ` step-${f}`,
        });
      }
      labelsSeen.add(thinkEl.textContent || "");
      const parsePct = (el: Element) => parseFloat(getComputedStyle(el).backgroundPositionX);
      thinkSamples.push(parsePct(thinkEl));
      workSamples.push(parsePct(workEl));
    }

    // Ensure at least 2.2s elapsed even on >60Hz virtual timers so 1s intervals ticked multiple times
    while (labelsSeen.size < 2) {
      await new Promise((r) => setTimeout(r, 250));
      labelsSeen.add(thinkEl.textContent || "");
    }

    const currentThinkEl = document.querySelector('[data-thinking-row] .ui-shimmer, .ui-shimmer[data-thinking-label]');
    const currentWorkEl = document.querySelector('[data-turn-status] .ui-shimmer');
    const finalElapsedLabel = document.querySelector("[data-turn-status]")?.textContent || "";

    return {
      sameThinkDom: currentThinkEl === thinkEl,
      sameWorkDom: currentWorkEl === workEl,
      thinkLabelsCount: labelsSeen.size,
      initialThinkLabel,
      finalThinkLabel: thinkEl.textContent || "",
      initialElapsedLabel,
      finalElapsedLabel,
      thinkSamples,
      workSamples,
    };
  });

  assert.equal(thinkingAudit.sameThinkDom, true, "Thinking .ui-shimmer must retain identical DOM node across 1s ticks and reasoning deltas");
  assert.equal(thinkingAudit.sameWorkDom, true, "Working .ui-shimmer must retain identical DOM node across 1s ticks");
  assert(
    thinkingAudit.thinkLabelsCount >= 2 && thinkingAudit.initialThinkLabel !== thinkingAudit.finalThinkLabel,
    `Thinking label must advance across 1s ticks (got ${thinkingAudit.initialThinkLabel} -> ${thinkingAudit.finalThinkLabel})`,
  );

  function assertMonotonicShimmerSamples(label: string, samples: number[]) {
    assert(samples.length >= 90, `${label}: expected >= 90 rAF samples, got ${samples.length}`);
    let wraps = 0;
    for (let i = 0; i < samples.length; i++) {
      const cur = samples[i]!;
      assert(Number.isFinite(cur) && cur >= -0.05 && cur <= 200.05, `${label}[${i}] out of [0%, 200%] bounds: ${cur}%`);
      if (i === 0) continue;
      const prev = samples[i - 1]!;
      if (cur <= prev + 0.05) {
        // Normal monotonic decrease 200% -> 0% (wave gliding left-to-right)
        continue;
      }
      // Must be a legitimate periodic wraparound near 0% -> 200% (never a mid-cycle reset!)
      const wrappedStep = prev + (200 - cur);
      assert(
        prev < 45 && cur > 155 && wrappedStep >= 0 && wrappedStep < 45,
        `${label} jumped/reset mid-cycle at frame ${i}: ${prev.toFixed(2)}% -> ${cur.toFixed(2)}%`,
      );
      wraps++;
    }
    return wraps;
  }

  assertMonotonicShimmerSamples("thinking-row", thinkingAudit.thinkSamples);
  assertMonotonicShimmerSamples("working-row (phase 1)", thinkingAudit.workSamples);

  // -------------------------------------------------------------------------
  // 2. Full Multi-Surface Active Streaming Audit in BOTH Dark and Light Themes
  //    (> 3.2 seconds & >= 180 rAF ticks per theme, mid-stream updates + late mount)
  // -------------------------------------------------------------------------
  const stripsByTheme: Record<"dark" | "light", StripFrame[]> = { dark: [], light: [] };

  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((th: string) => {
      document.documentElement.dataset.theme = th;
      delete document.documentElement.dataset.reducedMotion;
      const ui = (window as any).shimmerUI;
      ui.setLateMount(false);
      ui.seedActiveWorkspace();
    }, theme);

    await page.waitForTimeout(60);

    const streamAudit = await page.evaluate(async () => {
      const ui = (window as any).shimmerUI;
      const startWall = performance.now();

      const getRefs = () => ({
        ds: document.querySelector("#ds-shimmer-card .ui-shimmer") as HTMLElement | null,
        rail: document.querySelector("[data-step-rail-header] .ui-shimmer") as HTMLElement | null,
        toolVerb: document.querySelector(".group\\/tool .ui-shimmer") as HTMLElement | null,
        changes: document.querySelector("#live-changes .ui-shimmer") as HTMLElement | null,
        queue: document.querySelector('[data-queue-item-state="interrupt"] .ui-shimmer') as HTMLElement | null,
        work: document.querySelector("[data-turn-status] .ui-shimmer") as HTMLElement | null,
        todo: document.querySelector('[data-todo-status="in_progress"] .ui-shimmer') as HTMLElement | null,
      });

      const initial = getRefs();
      for (const [k, v] of Object.entries(initial)) {
        if (!v) throw new Error(`Missing active shimmer surface "${k}"`);
      }

      const initialTurnStatus = document.querySelector("[data-turn-status]")?.textContent || "";
      const initialRailText = initial.rail!.textContent || "";
      const initialChangesText = initial.changes!.textContent || "";
      const turnStatusTicks = new Set<string>([initialTurnStatus]);

      const traces: Record<string, number[]> = {
        ds: [],
        rail: [],
        toolVerb: [],
        changes: [],
        queue: [],
        work: [],
        todo: [],
      };
      let lateJoinPhaseDiffPct = -1;

      const parsePct = (el: Element) => parseFloat(getComputedStyle(el).backgroundPositionX);
      const circularDiff200 = (a: number, b: number) => {
        const d = Math.abs(a - b) % 200;
        return d > 100 ? 200 - d : d;
      };

      let frame = 0;
      while (frame < 185 || performance.now() - startWall < 3250) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        frame++;

        // Inject real streaming mutations mid-flight to prove zero DOM recreation & zero phase reset:
        if (frame === 28) {
          // Stream args + progress on command 1 + re-pull queue + update todo list
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_use_args",
            id: "call_cmd_1",
            messageId: "a1",
            delta: ' -- --strict',
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_progress",
            id: "call_cmd_1",
            text: "Scanning 213 files...\n",
          });
          ui.q.noteQueue("s-shimmer", [
            {
              id: "q-int-1",
              text: "Capture light & dark contact sheet once checks pass",
              attachmentIds: [],
              model: "claude-sonnet",
              yolo: false,
              createdAt: 1700000000001,
              delivery: "interrupt",
            },
            {
              id: "q-pass-2",
              text: "Run full bun test suite",
              attachmentIds: [],
              model: "claude-sonnet",
              yolo: false,
              createdAt: 1700000000002,
              delivery: "queue",
            },
          ]);
        } else if (frame === 62) {
          // Complete command 1 & start command 2 -> `Ran 1 command` updates to `Ran 2 commands`!
          // Also grow TurnChangesBalloon `1 file changed` -> `2 files changed` and fire todo_update!
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_result",
            id: "call_cmd_1",
            messageId: "a1",
            result: "OK",
            durationMs: 420,
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_use_start",
            id: "call_cmd_2",
            name: "bash",
            messageId: "a1",
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_call",
            id: "call_cmd_2",
            name: "bash",
            args: { command: "bun run typecheck && bun run lint" },
            messageId: "a1",
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_execution_start",
            id: "call_cmd_2",
            startedAt: Date.now(),
          });
          ui.tc.noteBalloon(
            {
              turnIndex: 1,
              files: [
                { path: "web/src/ds/components.css", status: "modified", additions: 24, deletions: 5, diff: "+shimmer" },
                { path: "web/src/ds/motion/shimmer.ts", status: "new", additions: 88, deletions: 0, diff: "+sync" },
              ],
            },
            true,
          );
          ui.t.handleAgentEvent("s-shimmer", {
            type: "todo_update",
            items: [
              { text: "Audit CSS background-position period math", status: "completed" },
              { text: "Verify monotonic shimmer wave across 90+ rAF frames", status: "in_progress" },
              { text: "Save light/dark verification contact sheet", status: "pending" },
            ],
          });
        } else if (frame === 96) {
          // Mount a brand-new shimmer element mid-cycle and measure phase alignment on its VERY FIRST rAF!
          ui.setLateMount(true);
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          const lateEl = document.querySelector("[data-late-shimmer] .ui-shimmer");
          if (!lateEl) throw new Error("Late-mounted shimmer element missing");
          lateJoinPhaseDiffPct = circularDiff200(parsePct(lateEl), parsePct(initial.work!));
        } else if (frame === 125) {
          // Grow aggregate summary again (`Explored 1 file · Ran 2 commands`) & balloon (`3 files changed`)
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_result",
            id: "call_cmd_2",
            messageId: "a1",
            result: "0 errors",
            durationMs: 510,
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_use_start",
            id: "call_read_3",
            name: "read",
            messageId: "a1",
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_call",
            id: "call_read_3",
            name: "read",
            args: { path: "web/src/ds/components.css" },
            messageId: "a1",
          });
          ui.t.handleAgentEvent("s-shimmer", {
            type: "tool_execution_start",
            id: "call_read_3",
            startedAt: Date.now(),
          });
          ui.tc.noteBalloon(
            {
              turnIndex: 1,
              files: [
                { path: "web/src/ds/components.css", status: "modified", additions: 24, deletions: 5, diff: "+shimmer" },
                { path: "web/src/ds/motion/shimmer.ts", status: "new", additions: 88, deletions: 0, diff: "+sync" },
                { path: "web/src/indirect-code/components/composer/StatusBanners.tsx", status: "modified", additions: 12, deletions: 5, diff: "+index" },
              ],
            },
            true,
          );
        }

        turnStatusTicks.add(document.querySelector("[data-turn-status]")?.textContent || "");
        traces.ds.push(parsePct(initial.ds!));
        traces.rail.push(parsePct(initial.rail!));
        traces.changes.push(parsePct(initial.changes!));
        traces.queue.push(parsePct(initial.queue!));
        traces.work.push(parsePct(initial.work!));
        traces.todo.push(parsePct(initial.todo!));

        // Note: initial.toolVerb was command 1's verb (which completed at frame 62);
        // before frame 62 it must remain active and monotonic.
        if (frame < 62) {
          traces.toolVerb.push(parsePct(initial.toolVerb!));
        }
      }

      const after = getRefs();
      // Compute max pairwise phase spread across all persistent surfaces on the final frame
      const finalPcts = [
        traces.ds.at(-1)!,
        traces.rail.at(-1)!,
        traces.changes.at(-1)!,
        traces.queue.at(-1)!,
        traces.work.at(-1)!,
        traces.todo.at(-1)!,
      ];
      let maxPhaseSpreadPct = 0;
      for (const p of finalPcts) {
        maxPhaseSpreadPct = Math.max(maxPhaseSpreadPct, circularDiff200(p, finalPcts[0]!));
      }

      return {
        finalPcts,
        frames: frame,
        elapsedMs: performance.now() - startWall,
        identity: {
          ds: after.ds === initial.ds,
          rail: after.rail === initial.rail,
          changes: after.changes === initial.changes,
          queue: after.queue === initial.queue,
          work: after.work === initial.work,
          todo: after.todo === initial.todo,
        },
        initialRailText,
        finalRailText: after.rail?.textContent || "",
        initialChangesText,
        finalChangesText: after.changes?.textContent || "",
        turnStatusTickCount: turnStatusTicks.size,
        lateJoinPhaseDiffPct,
        maxPhaseSpreadPct,
        traces,
      };
    });

    assert.deepEqual(
      streamAudit.identity,
      { ds: true, rail: true, changes: true, queue: true, work: true, todo: true },
      `[${theme}] Every persistent .ui-shimmer element must keep strict el1 === el2 DOM identity`,
    );
    assert(
      streamAudit.turnStatusTickCount >= 3,
      `[${theme}] Working · Ns must tick at least 3 times across >3.2s (saw ${streamAudit.turnStatusTickCount} distinct labels)`,
    );
    assert.equal(streamAudit.initialRailText, "Ran 1 command");
    assert.equal(streamAudit.finalRailText, "Explored 1 file · Ran 2 commands");
    assert.equal(streamAudit.initialChangesText, "1 file changed");
    assert.equal(streamAudit.finalChangesText, "3 files changed");
    assert(
      streamAudit.lateJoinPhaseDiffPct >= 0 && streamAudit.lateJoinPhaseDiffPct < 4,
      `[${theme}] Late-mounted .ui-shimmer must phase-lock to global wave within 4% (got ${streamAudit.lateJoinPhaseDiffPct.toFixed(2)}%)`,
    );
    assert(
      streamAudit.maxPhaseSpreadPct < 3,
      `[${theme}] All simultaneously active .ui-shimmer nodes must stay phase-locked within 3% (got ${streamAudit.maxPhaseSpreadPct.toFixed(2)}%; ds/rail/changes/queue/work/todo=${streamAudit.finalPcts.map((p: number) => p.toFixed(1)).join("/")})`,
    );

    for (const key of ["ds", "rail", "changes", "queue", "work", "todo"] as const) {
      const wraps = assertMonotonicShimmerSamples(`${theme}:${key}`, streamAudit.traces[key]);
      assert(wraps >= 1, `[${theme}:${key}] Expected at least 1 seamless 2.2s wraparound over ${streamAudit.elapsedMs.toFixed(0)}ms`);
    }

    // -----------------------------------------------------------------------
    // 3. Deterministic 6-Phase Pixel-Contrast & Zero-Invisible-Glyph Audit
    //    Pause animations at exact fractions [0.00, 0.20, 0.40, 0.50, 0.72, 0.98]
    //    of the 2200ms cycle, screenshot the stage, and verify rendered glyph contrast!
    // -----------------------------------------------------------------------
    const phaseFractions = [0.0, 0.2, 0.4, 0.5, 0.72, 0.98];
    for (const frac of phaseFractions) {
      await page.evaluate((f: number) => {
        for (const el of document.querySelectorAll(".ui-shimmer")) {
          for (const anim of el.getAnimations()) {
            if ((anim as CSSAnimation).animationName !== "ui-shimmer") continue;
            anim.pause();
            const delay = Number(anim.effect?.getTiming().delay || 0);
            anim.currentTime = delay + f * 2200;
          }
        }
      }, frac);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

      const stageLoc = page.locator("#shimmer-stage");
      const pngBuf = await stageLoc.screenshot({ type: "png" });
      const dataUrl = `data:image/png;base64,${pngBuf.toString("base64")}`;

      const pixelMetrics = await page.evaluate(async (url: string) => {
        const stage = document.getElementById("shimmer-stage")!;
        const stageRect = stage.getBoundingClientRect();
        const img = new Image();
        img.src = url;
        await img.decode();
        const scaleX = img.naturalWidth / stageRect.width;
        const scaleY = img.naturalHeight / stageRect.height;
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);

        function inspectBox(el: Element) {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.floor((r.left - stageRect.left) * scaleX));
          const y = Math.max(0, Math.floor((r.top - stageRect.top) * scaleY));
          const w = Math.max(1, Math.floor(r.width * scaleX));
          const h = Math.max(1, Math.floor(r.height * scaleY));
          const data = ctx.getImageData(x, y, w, h).data;
          // Estimate local surface background from top-left corner pixel of bounding box
          const bgLum = 0.2126 * data[0]! + 0.7152 * data[1]! + 0.0722 * data[2]!;
          let glyphPixels = 0;
          let maxDelta = 0;
          for (let p = 0; p < data.length; p += 4) {
            const alpha = data[p + 3]!;
            if (alpha < 200) continue;
            const lum = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
            const delta = Math.abs(lum - bgLum);
            if (delta > 28) glyphPixels++;
            if (delta > maxDelta) maxDelta = delta;
          }
          return { glyphPixels, maxDelta };
        }

        const targets = [
          document.querySelector("#ds-shimmer-card .ui-shimmer")!,
          document.querySelector("[data-step-rail-header] .ui-shimmer")!,
          document.querySelector("#live-changes .ui-shimmer")!,
          document.querySelector("[data-turn-status] .ui-shimmer")!,
          document.querySelector('[data-todo-status="in_progress"] .ui-shimmer')!,
          document.querySelector('[data-queue-item-state="interrupt"] .ui-shimmer')!,
        ];
        const perTarget = targets.map((el) => inspectBox(el));
        const nestedSpan = inspectBox(document.querySelector("#ds-shimmer-card .ui-shimmer span")!);
        return {
          minGlyphPixels: Math.min(...perTarget.map((m) => m.glyphPixels)),
          minMaxDelta: Math.min(...perTarget.map((m) => m.maxDelta)),
          nestedSpanGlyphPixels: nestedSpan.glyphPixels,
          nestedSpanDelta: nestedSpan.maxDelta,
        };
      }, dataUrl);

      assert(
        pixelMetrics.minGlyphPixels >= 40 && pixelMetrics.minMaxDelta >= 55,
        `[${theme} @ ${(frac * 100).toFixed(0)}%] Blank/low-contrast shimmer glyphs detected: minGlyphPixels=${pixelMetrics.minGlyphPixels}, minMaxDelta=${pixelMetrics.minMaxDelta.toFixed(1)}`,
      );
      assert(
        pixelMetrics.nestedSpanGlyphPixels >= 25 && pixelMetrics.nestedSpanDelta >= 55,
        `[${theme} @ ${(frac * 100).toFixed(0)}%] Nested <span> inside .ui-shimmer rendered invisible: pixels=${pixelMetrics.nestedSpanGlyphPixels}`,
      );

      stripsByTheme[theme].push({
        phaseLabel: `${Math.round(frac * 100)}% (${Math.round(frac * 2200)}ms)`,
        dataUrl,
        visibleGlyphPixels: pixelMetrics.minGlyphPixels,
        nestedSpanGlyphPixels: pixelMetrics.nestedSpanGlyphPixels,
        maxContrastDelta: pixelMetrics.minMaxDelta,
      });
    }

    // Resume and re-lock CSSAnimations on persistent DOM nodes before next theme pass
    await page.evaluate(() => {
      const now = Number(document.timeline?.currentTime ?? performance.now());
      for (const el of document.querySelectorAll(".ui-shimmer")) {
        for (const anim of el.getAnimations()) {
          if ((anim as CSSAnimation).animationName !== "ui-shimmer") continue;
          const delay = Number(anim.effect?.getTiming().delay || 0);
          const anchor = Math.floor((now + Math.min(0, delay)) / 2200) * 2200;
          anim.play();
          anim.startTime = anchor - delay;
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 3b. Adversarial Web Animations `before`-Phase Freeze Regressions:
  //     (a) Boundary-crossing negative delay mount when `(now % 2200) < -delay`
  //     (b) `DisclosureBody` (`display: none`) collapse -> re-expand when `(now % 2200) < -delay`
  // -------------------------------------------------------------------------
  const boundaryAndDisclosureAudit = await page.evaluate(async () => {
    document.documentElement.dataset.theme = "dark";
    delete document.documentElement.dataset.reducedMotion;
    const ui = (window as any).shimmerUI;
    ui.seedActiveWorkspace();
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

    const parsePct = (el: Element) => parseFloat(getComputedStyle(el).backgroundPositionX);
    const circularDiff200 = (a: number, b: number) => {
      const d = Math.abs(a - b) % 200;
      return d > 100 ? 200 - d : d;
    };
    const waitForEarlyCycleWindow = async () => {
      for (let guard = 0; guard < 300; guard++) {
        const now = Number(document.timeline?.currentTime ?? performance.now());
        const mod = now % 2200;
        if (mod >= 25 && mod <= 450) return now;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }
      throw new Error("Timed out waiting for early (now % 2200) window");
    };

    const workEl = document.querySelector("[data-turn-status] .ui-shimmer") as HTMLElement;
    const railBtn = document.querySelector("[data-step-rail-header]") as HTMLButtonElement;
    const toolVerbEl = document.querySelector(".group\\/tool .ui-shimmer") as HTMLElement;
    if (!workEl || !railBtn || !toolVerbEl) {
      throw new Error("Missing work/rail/toolVerb elements for boundary & disclosure audit");
    }

    // (a) Mount an element with --ui-shimmer-delay: -2195ms right after a 2200ms boundary
    //     so (now % 2200) << -delay (2195ms). Old code set startTime > now (frozen at 200%).
    await waitForEarlyCycleWindow();
    const probe = document.createElement("span");
    probe.className = "ui-shimmer font-medium";
    probe.style.setProperty("--ui-shimmer-delay", "-2195ms");
    probe.textContent = "Boundary crossing probe";
    document.getElementById("ds-shimmer-card")!.appendChild(probe);

    const probeSamples: number[] = [];
    const workSamplesA: number[] = [];
    let probeStartMinusNow = Infinity;
    let maxDiffA = 0;

    for (let f = 0; f < 20; f++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (f === 0) {
        const now = Number(document.timeline?.currentTime ?? performance.now());
        const anim = probe
          .getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "ui-shimmer");
        probeStartMinusNow = Number(anim?.startTime ?? Infinity) - now;
      }
      const pPct = parsePct(probe);
      const wPct = parsePct(workEl);
      probeSamples.push(pPct);
      workSamplesA.push(wPct);
      maxDiffA = Math.max(maxDiffA, circularDiff200(pPct, wPct));
    }
    probe.remove();

    // (b) Collapse [data-step-rail-header] (DisclosureBody sets display: none),
    //     pin a steep negative --ui-shimmer-delay (-2050ms) on the active tool verb,
    //     wait until (now % 2200) is in [25, 450]ms (< 2050ms), and re-expand!
    toolVerbEl.style.setProperty("--ui-shimmer-delay", "-2050ms");
    if (railBtn.getAttribute("aria-expanded") === "true") {
      railBtn.click();
    }
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    await waitForEarlyCycleWindow();
    railBtn.click(); // display: none -> block triggers fresh CSSAnimation + animationstart!

    const verbSamples: number[] = [];
    const workSamplesB: number[] = [];
    let verbStartMinusNow = Infinity;
    let maxDiffB = 0;

    for (let f = 0; f < 20; f++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (f === 0) {
        const now = Number(document.timeline?.currentTime ?? performance.now());
        const anim = toolVerbEl
          .getAnimations()
          .find((a) => (a as CSSAnimation).animationName === "ui-shimmer");
        verbStartMinusNow = Number(anim?.startTime ?? Infinity) - now;
      }
      const vPct = parsePct(toolVerbEl);
      const wPct = parsePct(workEl);
      verbSamples.push(vPct);
      workSamplesB.push(wPct);
      maxDiffB = Math.max(maxDiffB, circularDiff200(vPct, wPct));
    }

    return {
      probeStartMinusNow,
      probeSamples,
      workSamplesA,
      maxDiffA,
      verbStartMinusNow,
      verbSamples,
      workSamplesB,
      maxDiffB,
    };
  });

  assert(
    boundaryAndDisclosureAudit.probeStartMinusNow <= 0,
    `Boundary-crossing .ui-shimmer startTime must never exceed timeline.currentTime (startTime - now = ${boundaryAndDisclosureAudit.probeStartMinusNow.toFixed(2)}ms)`,
  );
  assert(
    new Set(boundaryAndDisclosureAudit.probeSamples.map((v: number) => v.toFixed(2))).size >= 10 &&
      boundaryAndDisclosureAudit.maxDiffA < 3,
    `Boundary-crossing .ui-shimmer must advance immediately without freezing at 200% (maxDiff=${boundaryAndDisclosureAudit.maxDiffA.toFixed(2)}%, samples=${boundaryAndDisclosureAudit.probeSamples.slice(0, 6).map((n: number) => n.toFixed(1)).join(",")})`,
  );
  assert(
    boundaryAndDisclosureAudit.verbStartMinusNow <= 0,
    `Re-expanded DisclosureBody .ui-shimmer startTime must never exceed timeline.currentTime (startTime - now = ${boundaryAndDisclosureAudit.verbStartMinusNow.toFixed(2)}ms)`,
  );
  assert(
    new Set(boundaryAndDisclosureAudit.verbSamples.map((v: number) => v.toFixed(2))).size >= 10 &&
      boundaryAndDisclosureAudit.maxDiffB < 3,
    `Re-expanded DisclosureBody .ui-shimmer must advance immediately in phase with Working (maxDiff=${boundaryAndDisclosureAudit.maxDiffB.toFixed(2)}%, samples=${boundaryAndDisclosureAudit.verbSamples.slice(0, 6).map((n: number) => n.toFixed(1)).join(",")})`,
  );

  // -------------------------------------------------------------------------
  // 4. Reduced Motion Verification (`data-reduced-motion="reduce"`)
  // -------------------------------------------------------------------------
  const reducedAudit = await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "reduce";
    const el = document.querySelector("[data-turn-status] .ui-shimmer")!;
    const cs = getComputedStyle(el);
    return {
      animationName: cs.animationName,
      backgroundImage: cs.backgroundImage,
      color: cs.color,
      webkitTextFillColor: (cs as any).webkitTextFillColor,
    };
  });
  assert.equal(reducedAudit.animationName, "none", "Reduced motion must disable ui-shimmer animation");
  assert.equal(reducedAudit.backgroundImage, "none", "Reduced motion must clear gradient background");
  assert.notEqual(reducedAudit.color, "rgba(0, 0, 0, 0)", "Reduced motion must restore solid legible text color");

  // -------------------------------------------------------------------------
  // 5. Optional Verification Contact Sheet Export (`--contact-sheet <path>`)
  // -------------------------------------------------------------------------
  const contactSheetOut = resolveContactSheetPath();
  if (contactSheetOut) {
    const sheetBase64 = await page.evaluate(
      async (strips: Record<"dark" | "light", StripFrame[]>) => {
        const decode = async (url: string) => {
          const img = new Image();
          img.src = url;
          await img.decode();
          return img;
        };
        const darkImgs = await Promise.all(strips.dark.map((s) => decode(s.dataUrl)));
        const lightImgs = await Promise.all(strips.light.map((s) => decode(s.dataUrl)));
        const cardW = 540;
        const scale = cardW / darkImgs[0]!.naturalWidth;
        const cardH = Math.round(darkImgs[0]!.naturalHeight * scale);
        const pad = 24;
        const headerH = 68;
        const labelH = 30;
        const cols = 3;
        const rowsPerTheme = 2;
        const themeBlockH = 40 + rowsPerTheme * (cardH + labelH + 14);
        const totalW = pad * 2 + cols * cardW + (cols - 1) * 16;
        const totalH = headerH + pad * 2 + themeBlockH * 2 + 24;

        const canvas = document.createElement("canvas");
        canvas.width = totalW;
        canvas.height = totalH;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#0e1013";
        ctx.fillRect(0, 0, totalW, totalH);

        ctx.fillStyle = "#f4f5f7";
        ctx.font = "500 22px system-ui, -apple-system, sans-serif";
        ctx.fillText("Indirect Code — Seamless Text Shimmer Verification (Dark & Light Themes, 2200ms Period)", pad, 36);
        ctx.fillStyle = "#9aa0aa";
        ctx.font = "400 13px ui-monospace, monospace";
        ctx.fillText(
          "200% -> 0% exact 1-tile shift · raised-cosine oklab bell · strict el1===el2 DOM identity · wall-clock phase lock · 0 blank frames",
          pad,
          58,
        );

        const drawThemeSection = (
          title: string,
          imgs: HTMLImageElement[],
          frames: StripFrame[],
          startY: number,
        ) => {
          ctx.fillStyle = "#53dca6";
          ctx.font = "500 16px system-ui, -apple-system, sans-serif";
          ctx.fillText(title, pad, startY + 22);

          imgs.forEach((img, idx) => {
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const x = pad + col * (cardW + 16);
            const y = startY + 34 + row * (cardH + labelH + 14);
            ctx.fillStyle = "#1b1e24";
            ctx.fillRect(x - 1, y - 1, cardW + 2, cardH + labelH + 2);
            ctx.drawImage(img, x, y + labelH, cardW, cardH);
            ctx.fillStyle = "#e4e7ec";
            ctx.font = "500 12px ui-monospace, monospace";
            const meta = frames[idx]!;
            ctx.fillText(
              `Phase ${meta.phaseLabel} · minPixels=${meta.visibleGlyphPixels} · ΔL=${meta.maxContrastDelta.toFixed(0)}`,
              x + 10,
              y + 19,
            );
          });
        };

        drawThemeSection("Dark Theme — 6 Phase Checkpoints Across Full 2.2s Cycle", darkImgs, strips.dark, headerH + 8);
        drawThemeSection(
          "Light Theme — 6 Phase Checkpoints Across Full 2.2s Cycle",
          lightImgs,
          strips.light,
          headerH + 8 + themeBlockH + 16,
        );

        return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
      },
      stripsByTheme,
    );

    mkdirSync(path.dirname(contactSheetOut), { recursive: true });
    writeFileSync(contactSheetOut, Buffer.from(sheetBase64, "base64"));
    console.log(`Saved verification contact sheet -> ${contactSheetOut}`);
  }

  assert.deepEqual(errors, []);
  console.log("PASS: shimmer frame-by-frame continuity, strict DOM identity, wall-clock phase lock, and light/dark contrast");
} finally {
  await browser.close();
  server.stop(true);
}
