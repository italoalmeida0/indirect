/**
 * scripts/test-indirect-lsm-context-e2e.ts — full-stack E2E verification for
 * Multi-Tier LSM FoldBlocks, UI Era Timeline, BM25 `session_history` recall,
 * foreground >20KB `brain/` arrival spill, in-process read-only `explore`
 * subagent, and granular `TruncateCompaction` rewind.
 *
 *   E2E_API_KEY=... E2E_BASE_URL=https://openrouter.ai/api/v1 E2E_MODEL=deepseek/deepseek-v4.1-flash-1017 \
 *     PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... \
 *     bun scripts/test-indirect-lsm-context-e2e.ts [eras|spill|explore|rewind|all]
 *
 * Prerequisites: web dist/ built (`bun run build:web`), daemon binary built
 * (`bun run build:daemon`).
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { promises as fs } from "fs";
import { homedir, tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(ROOT, "..");
const envFile = await fs.readFile(path.join(WS, ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};

const E2E_KEY = envGet("E2E_API_KEY") || envGet("OPENROUTER_API_KEY") || envGet("META_API_KEY");
const usesOpenRouter = Boolean(
  envGet("OPENROUTER_API_KEY") || /openrouter/i.test(envGet("E2E_BASE_URL") || envGet("OPENROUTER_BASE_URL") || ""),
);
const E2E_BASE =
  envGet("E2E_BASE_URL") ||
  (usesOpenRouter
    ? envGet("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1"
    : envGet("META_BASE_URL") || "https://api.meta.ai/v1");
const MODEL = envGet("E2E_MODEL") || (usesOpenRouter ? "deepseek/deepseek-v4.1-flash-1017" : "muse-spark-1.3-contributor");

if (!E2E_KEY) {
  console.error("E2E_API_KEY / OPENROUTER_API_KEY / META_API_KEY missing — set in environment or .env (gitignored)");
  process.exit(2);
}

const daemonBin = path.join(
  WS,
  "indirect-code-daemon",
  "bin",
  process.platform === "win32" ? "indirect-code.exe" : "indirect-code",
);
if (!(await fs.stat(daemonBin).catch(() => null))) {
  console.error(`daemon binary missing (${daemonBin}): run bun run build:daemon first`);
  process.exit(2);
}
if (!(await fs.stat(path.join(WS, "dist", "index.html")).catch(() => null))) {
  console.error("web dist/ missing: run bun run build:web first");
  process.exit(2);
}

async function resolveChrome(): Promise<string> {
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
      if (cand && (await fs.stat(cand).catch(() => null))) return cand;
    }
  }
  const unixCache = path.join(process.env.HOME || homedir(), ".cache", "ms-playwright");
  const unixDirs = [
    ...new Set([
      ...(await fs.readdir(unixCache).catch(() => [] as string[]))
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse(),
      "chromium-1234",
      "chromium-1228",
    ]),
  ];
  for (const d of unixDirs) {
    for (const c of [
      path.join(unixCache, d, "chrome-linux64", "chrome"),
      path.join(unixCache, d, "chrome-linux", "chrome"),
    ]) {
      if (await fs.stat(c).catch(() => null)) return c;
    }
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome", "chrome", "msedge"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  console.error("no Chrome/Edge found: set CHROMIUM_PATH");
  process.exit(2);
}

const GW_PORT = Number(process.env.E2E_LSM_GW_PORT || 4619);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-lsm-pass-1";
const procs: Array<{ kill: () => void }> = [];

function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

const KNOWN_CONSOLE_NOISE = [/Content Security Policy.*accounts\.google\.com/i, /gsi\/client/i];
function assertNoPageErrors(pageErrors: string[], consoleErrors: string[], where: string) {
  assert.deepEqual(pageErrors, [], `${where}: page errors: ${pageErrors.join(" | ")}`);
  const fresh = consoleErrors.filter((m) => !KNOWN_CONSOLE_NOISE.some((re) => re.test(m)));
  assert.deepEqual(fresh, [], `${where}: console errors: ${fresh.join(" | ")}`);
}

async function boot() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-lsm-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(GW_PORT),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com",
      ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(gwProc);

  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${GW}/api/health`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }

  const login: any = await (
    await fetch(`${GW}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
    })
  ).json();
  assert(login.success, "admin login failed");
  const jwt = login.accessToken;
  const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

  await fetch(`${GW}/api/admin/providers`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "lsm-e2e", openaiBaseUrl: E2E_BASE, apiKey: E2E_KEY, openaiAuthStyle: "bearer" }),
  });
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const createdProv = (list.providers || []).find((p: any) => p.name === "lsm-e2e");
  const providerId = createdProv?.id;
  assert(providerId, `provider not found after create: ${JSON.stringify(list).slice(0, 300)}`);

  let mkModel: any = await (
    await fetch(`${GW}/api/admin/models`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 128000 }),
    })
  ).json();
  if (!mkModel.success && /already registered/.test(mkModel.error || "")) {
    mkModel = await (
      await fetch(`${GW}/api/admin/models/${encodeURIComponent(MODEL)}`, {
        method: "PATCH",
        headers: auth,
        body: JSON.stringify({ providerId, upstreamModel: MODEL, contextLength: 128000 }),
      })
    ).json();
  }
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);

  const pair: any = await (
    await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })
  ).json();
  assert(pair.success && pair.connectUrl, "pairing failed");

  const daemonDir = mkdtempSync(path.join(tmpdir(), "llmgw-lsm-d-"));
  const workDir = path.join(daemonDir, "workspace");
  mkdirSync(workDir, { recursive: true });
  if (process.platform === "win32") {
    const cachedUnish = path.join(homedir(), ".indirect-code", "external", "bin", "unish.exe");
    if (existsSync(cachedUnish)) {
      const destUnish = path.join(daemonDir, "external", "bin", "unish.exe");
      mkdirSync(path.dirname(destUnish), { recursive: true });
      copyFileSync(cachedUnish, destUnish);
    }
  }

  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "LSM Context E2E"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" },
  );
  procs.push(daemonProc);

  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/indirect-code/ws?token=${encodeURIComponent(jwt)}`);
  let reqId = 0;
  const pending = new Map<string, (v: any) => void>();
  let hostId = "";
  const send = (payload: any) => {
    payload.requestId = `r${++reqId}`;
    payload.hostId = hostId;
    ws.send(JSON.stringify(payload));
    return new Promise<any>((resolve) => {
      pending.set(payload.requestId, resolve);
      setTimeout(() => {
        if (pending.has(payload.requestId)) {
          pending.delete(payload.requestId);
          resolve(undefined);
        }
      }, 30000);
    });
  };
  const events: any[] = [];
  await new Promise<void>((res) => {
    ws.onopen = () => res();
  });
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.requestId && pending.has(msg.requestId)) {
        pending.get(msg.requestId)!(msg);
        pending.delete(msg.requestId);
        return;
      }
      events.push(msg);
    } catch {}
  };

  const start = Date.now();
  while (!hostId && Date.now() - start < 20000) {
    const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
    const f = (h.hosts || []).find((x: any) => x.name === "LSM Context E2E" && x.status === "online");
    if (f) hostId = f.id;
    else await Bun.sleep(300);
  }
  assert(hostId, "daemon host never came online");
  await send({ type: "config", settings: { auto_compact_threshold: 0 } });
  log("boot", `gateway + daemon up (host ${hostId}, model ${MODEL})`);
  return { jwt, login, hostId, ws, send, daemonDir, workDir, events, gw: GW, auth };
}

async function openSessionPage(ctx: any, sessionId: string) {
  const browser = await chromium.launch({
    executablePath: await resolveChrome(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m: any) => {
    if (m.type() === "error") consoleErrors.push(String(m.text()).slice(0, 300));
  });
  await page.addInitScript(
    ({ sess, hid, sid }: any) => {
      localStorage.setItem("cache_code_session", JSON.stringify(sess));
      localStorage.setItem(`llmgw-rc-session:${hid}`, sid);
    },
    {
      sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
      hid: ctx.hostId,
      sid: sessionId,
    },
  );
  await page.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  if ((await page.locator("[data-transcript-id]").count()) === 0) {
    await page.reload({ waitUntil: "networkidle" });
  }
  await page.waitForSelector("[data-transcript-id]", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);
  return { browser, page, pageErrors, consoleErrors };
}

function assistantHasText(messages: any[], expected: string): boolean {
  return (messages || []).some(
    (m: any) => m?.role === "assistant" && JSON.stringify(m.content ?? "").includes(expected),
  );
}

async function createAgenticSession(ctx: any, title: string): Promise<string> {
  const created: any = await ctx.send({
    type: "create_session",
    cwd: ctx.workDir,
    title,
    model: MODEL,
    options: { mode: "agentic", access: "full", skills: [{ name: "build" }] },
  });
  const sessionId = created?.session?.id;
  assert(sessionId, "create_session failed");
  return sessionId;
}

async function waitForTurnDone(ctx: any, sessionId: string, eventStart: number, timeoutMs = 180000) {
  const t0 = Date.now();
  let lastStatus = "";
  for (;;) {
    await Bun.sleep(1500);
    const finishedEv = ctx.events
      .slice(eventStart)
      .some((e: any) => e?.type === "turn_finished" && e?.sessionId === sessionId);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const st = data?.session?.status;
    const msgs = data?.session?.messages || [];
    if (st !== lastStatus) {
      lastStatus = st;
      log("turn", `status=${st} msgs=${msgs.length} after ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    if (finishedEv && st && st !== "running") {
      return data;
    }
    if (Date.now() - t0 >= timeoutMs) {
      const tail = ctx.events.slice(-15).map((e: any) => JSON.stringify(e).slice(0, 200));
      log("turn", `TIMEOUT; last msgs=${JSON.stringify(msgs.slice(-2)).slice(0, 400)}\nevent tail:\n${tail.join("\n")}`);
      assert(false, "turn timed out");
    }
  }
}

async function runTurn(ctx: any, sessionId: string, text: string, timeoutMs = 180000) {
  const eventStart = ctx.events.length;
  ctx.ws.send(
    JSON.stringify({
      type: "prompt",
      hostId: ctx.hostId,
      sessionId,
      model: MODEL,
      yolo: true,
      text,
    }),
  );
  return waitForTurnDone(ctx, sessionId, eventStart, timeoutMs);
}

async function waitForCompactionCount(ctx: any, sessionId: string, wantCount: number, timeoutMs = 180000) {
  const t0 = Date.now();
  for (;;) {
    await Bun.sleep(2000);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const comp = data?.session?.compaction;
    if ((comp?.count ?? 0) >= wantCount) return data;
    assert(Date.now() - t0 < timeoutMs, `compaction count ${wantCount} never landed`);
  }
}

function hasToolCall(messages: any[], toolName: string, fromIdx = 0): boolean {
  for (let i = fromIdx; i < messages.length; i++) {
    const m = messages[i];
    const blocks = Array.isArray(m?.content) ? m.content : [];
    for (const b of blocks) {
      const n = b?.name || b?.toolName || "";
      if (n === toolName) return true;
    }
  }
  return false;
}

// 1 & 4. Multi-Era Compaction + UI Era Timeline + Verbatim Needle Recall (`session_history`) + Granular Rewind (`TruncateCompaction`)
async function scenarioErasRecallAndRewind(ctx: any, opts: { runErasAndRecall: boolean; runRewind: boolean }) {
  log("test", "scenario 1: multi-era compaction + UI timeline + verbatim session_history recall");
  const sessionId = await createAgenticSession(ctx, "e2e lsm eras + recall");

  // Plant a 40-entry calibration dump in a temporary file, stream it via bash `cat`,
  // and immediately unlink it from disk so the needle exists ONLY in Turn-1 transcript history.
  const NEEDLE_TOKEN = "LSM_VERBATIM_9f4c2e71_X89";
  const NEEDLE_LOC = "src/calibration/matrix_v4.go:142";
  const dumpFile = path.join(ctx.workDir, "ephemeral_calibration.txt");
  const rows: string[] = [];
  for (let i = 1; i <= 40; i++) {
    if (i === 19) {
      rows.push(`ROW_${i} source=${NEEDLE_LOC} CALIBRATION_NEEDLE_CONST="${NEEDLE_TOKEN}"`);
    } else {
      rows.push(`ROW_${i} source=src/calibration/table_${i}.go:${10 + i} CALIBRATION_SLOT_${i}="DUMMY_HEX_${1000 + i * 37}"`);
    }
  }
  writeFileSync(dumpFile, rows.join("\n") + "\n", "utf8");

  // Era 1: Turn 0 runs `cat ephemeral_calibration.txt` via bash (stdout captures all 40 constants),
  // then the harness deletes the file from disk; Turns 1 & 2 run unrelated shell work so Turn 0 folds into b1.
  let t0Data = await runTurn(
    ctx,
    sessionId,
    "Execute the exact command `cat ephemeral_calibration.txt` using the `bash` tool (no pipes, no `head`, no `wc`, no redirection, and do NOT use `read`) so all 40 rows print to stdout. Do not repeat the 40 rows in your reply; just confirm execution.",
  );
  if (!JSON.stringify(t0Data?.session?.messages || []).includes(NEEDLE_TOKEN)) {
    t0Data = await runTurn(
      ctx,
      sessionId,
      "The file `ephemeral_calibration.txt` is in the current working directory. Run the exact bare command `cat ephemeral_calibration.txt` with the `bash` tool now.",
    );
  }
  assert(
    JSON.stringify(t0Data?.session?.messages || []).includes(NEEDLE_TOKEN),
    "Turn-0 bash stdout must capture NEEDLE_TOKEN in raw session history",
  );
  await fs.unlink(dumpFile);
  assert(!existsSync(dumpFile), "ephemeral_calibration.txt must be deleted so needle lives only in session history");

  for (let i = 1; i <= 2; i++) {
    await runTurn(ctx, sessionId, `Run \`echo era1-step-${i}-ok\` with bash and briefly confirm.`);
  }

  // First /compact -> creates Era b1
  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const afterB1 = await waitForCompactionCount(ctx, sessionId, 1);
  const b1Blocks = afterB1?.session?.compaction?.blocks || [];
  assert.equal(b1Blocks.length, 1, `expected 1 FoldBlock after first /compact, got ${b1Blocks.length}`);
  assert.equal(b1Blocks[0]?.id, "b1", `expected first block id b1, got ${b1Blocks[0]?.id}`);
  log("test", `era b1 created: [${b1Blocks[0].startIdx}..${b1Blocks[0].endIdx})`);

  // Era 2: 3 more turns, then second /compact -> creates Era b2 alongside b1
  for (let i = 0; i < 3; i++) {
    await runTurn(ctx, sessionId, `Run \`echo era2-phase-${i}-telemetry\` with bash and briefly confirm.`);
  }

  ctx.ws.send(JSON.stringify({ type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text: "/compact" }));
  const afterB2 = await waitForCompactionCount(ctx, sessionId, 2);
  const b2Blocks = afterB2?.session?.compaction?.blocks || [];
  assert.equal(b2Blocks.length, 2, `expected 2 FoldBlocks after second /compact, got ${b2Blocks.length}`);
  assert.equal(b2Blocks[0]?.id, "b1");
  assert.equal(b2Blocks[1]?.id, "b2");
  log("test", `era b2 created: b1=[${b2Blocks[0].startIdx}..${b2Blocks[0].endIdx}) b2=[${b2Blocks[1].startIdx}..${b2Blocks[1].endIdx})`);

  if (opts.runErasAndRecall) {
    // Verify UI Era Timeline in real Chromium on #/code
    const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
    try {
      await page.evaluate(() => {
        for (const el of [...document.querySelectorAll("*")]) {
          const h = el as HTMLElement;
          if (h.scrollHeight > h.clientHeight + 100 && /overflow|auto|scroll/i.test(getComputedStyle(h).overflowY)) {
            h.scrollTop = 0;
          }
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1500);

      const pill = page.locator('button:has-text("Context Compacted")').first();
      assert((await pill.count()) > 0, "Context Compacted pill must render on #/code");
      await pill.scrollIntoViewIfNeeded();
      const collapsedText = (await pill.textContent()) || "";
      log("ui", `collapsed pill text: ${collapsedText.trim()}`);
      assert(/2\s*eras/.test(collapsedText), `collapsed pill must show '2 eras', got: ${collapsedText}`);
      assert.equal(await pill.getAttribute("aria-expanded"), "false", "pill should start collapsed");
      await page.screenshot({ path: path.join(tmpdir(), "lsm-eras-collapsed.png"), fullPage: false });

      // Expand CompactionBalloon and verify both [b1] and [b2] Era timeline cards render
      await pill.click();
      await page.waitForTimeout(1000);
      assert.equal(await pill.getAttribute("aria-expanded"), "true", "pill should expand on click");
      const expandedDom = await page.evaluate(() => {
        const text = document.body.textContent || "";
        const badges = [...document.querySelectorAll("span")].map((el) => (el.textContent || "").trim());
        return {
          hasB1: badges.includes("b1") && /msgs #0–#/.test(text),
          hasB2: badges.includes("b2"),
          hasSummaryBubbleLeak: /## Context Summary \(compacted\)/.test(text),
          hasSystemTagLeak: /&lt;system-reminder&gt;|<system-reminder>/.test(document.body.innerHTML || ""),
        };
      });
      await page.screenshot({ path: path.join(tmpdir(), "lsm-eras-expanded.png"), fullPage: false });
      log("ui", `expanded timeline check: ${JSON.stringify(expandedDom)}`);
      assert(expandedDom.hasB1, "expanded CompactionBalloon must render b1 era card");
      assert(expandedDom.hasB2, "expanded CompactionBalloon must render b2 era card");
      assert(!expandedDom.hasSummaryBubbleLeak, "raw ## Context Summary header must not leak");
      assert(!expandedDom.hasSystemTagLeak, "raw <system-reminder> tag must not leak");
      assertNoPageErrors(pageErrors, consoleErrors, "eras-ui");
    } finally {
      await browser.close();
    }

    // Verbatim Needle Recall via session_history
    const preRecallLen = (afterB2?.session?.messages || []).length;
    const recallData = await runTurn(
      ctx,
      sessionId,
      "Use the `session_history` tool to search our compacted session transcript for `CALIBRATION_NEEDLE_CONST` (from `matrix_v4.go`), and reply with both its exact verbatim string value and exact `file:line` source.",
    );
    const recallMsgs = recallData?.session?.messages || [];
    assert(
      hasToolCall(recallMsgs, "session_history", preRecallLen),
      "model must invoke session_history tool to retrieve compacted Turn-1 needle",
    );
    const tailMsgs = recallMsgs.slice(preRecallLen);
    assert(assistantHasText(tailMsgs, NEEDLE_TOKEN), `verbatim needle ${NEEDLE_TOKEN} missing from recall response`);
    assert(
      assistantHasText(tailMsgs, NEEDLE_LOC) || assistantHasText(tailMsgs, "matrix_v4.go:142"),
      `file:line ${NEEDLE_LOC} missing from recall response`,
    );
    log("test", "scenario 1 PASS (2 eras UI + session_history verbatim needle recall)");
  }

  if (opts.runRewind) {
    log("test", "scenario 4: granular rewind (TruncateCompaction preserves b1 when rewinding at b2 boundary)");
    const preRewind: any = await ctx.send({ type: "get_session", sessionId });
    const blocksBefore = preRewind?.session?.compaction?.blocks || [];
    const b1 = blocksBefore.find((b: any) => b.id === "b1");
    const b2 = blocksBefore.find((b: any) => b.id === "b2");
    assert(b1 && b2, "expected both b1 and b2 before granular rewind");

    // Pick a user turn whose boundary row sits inside [b1.endIdx, b2.endIdx):
    // rewinding there cuts into b2 while keeping all of b1 strictly below the cut.
    const baseIdx = preRewind?.session?.fromIndex ?? 0;
    const allMsgs: any[] = preRewind?.session?.messages || [];
    const turnStartIdx = new Map<number, number>();
    allMsgs.forEach((m, i) => {
      const t = m?.turnIndex;
      if (typeof t === "number" && t > 0 && !turnStartIdx.has(t)) {
        turnStartIdx.set(t, baseIdx + i);
      }
    });
    let cutTurnId = -1;
    let cutRawIdx = -1;
    for (const [t, idx] of turnStartIdx.entries()) {
      if (idx >= b1.endIdx && idx < b2.endIdx) {
        cutTurnId = t;
        cutRawIdx = idx;
        break;
      }
    }
    assert(
      cutTurnId > 0,
      `expected a user turn boundary inside [${b1.endIdx}, ${b2.endIdx}), turns=${JSON.stringify([...turnStartIdx.entries()])}`,
    );
    const rewindEventStart = ctx.events.length;
    const drRes: any = await ctx.send({
      type: "discard_and_resend",
      sessionId,
      turnId: cutTurnId,
      model: MODEL,
      yolo: true,
      text: "Reply with the exact token REWIND-B1-INTACT and nothing else.",
    });
    log("rewind", `discard_and_resend turnId=${cutTurnId} (rawIdx=${cutRawIdx}) response: ${JSON.stringify(drRes)}`);
    const afterRewind = await waitForTurnDone(ctx, sessionId, rewindEventStart);
    assert(assistantHasText(afterRewind?.session?.messages || [], "REWIND-B1-INTACT"), "post-rewind turn did not complete cleanly");

    const blocksAfter = afterRewind?.session?.compaction?.blocks || [];
    log("rewind", `blocks after rewind at turnId=${cutTurnId} (rawIdx=${cutRawIdx}): ${JSON.stringify(blocksAfter.map((b: any) => ({ id: b.id, s: b.startIdx, e: b.endIdx })))}`);
    assert.equal(blocksAfter.length, 1, `expected only b1 to remain after rewinding at rawIdx=${cutRawIdx}, got ${blocksAfter.length}`);
    assert.equal(blocksAfter[0]?.id, "b1", `expected remaining block to be b1, got ${blocksAfter[0]?.id}`);
    assert.equal(blocksAfter[0]?.endIdx, b1.endIdx, "b1 endIdx must remain untouched");

    const { browser, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
    try {
      assertNoPageErrors(pageErrors, consoleErrors, "rewind-ui");
    } finally {
      await browser.close();
    }
    log("test", "scenario 4 PASS (granular rewind preserved b1 and dropped b2)");
  }
}

// 2. Foreground >20KB Arrival Spill to brain/ + Middle-of-Log Error Survival
async function scenarioArrivalSpill(ctx: any) {
  log("test", "scenario 2: foreground >20KB arrival spill to brain/ + middle-of-log error survival");
  const sessionId = await createAgenticSession(ctx, "e2e lsm arrival spill");

  const SPILL_ERROR_CODE = "FATAL_LSM_SPILL_CODE_8841";
  const spillFixturePath = path.join(ctx.workDir, "pipeline_run.log");
  const logLines: string[] = [];
  for (let i = 1; i <= 220; i++) {
    logLines.push(`[2026-11-11T12:00:00Z] [INFO] worker-${String(i).padStart(3, "0")} processing pipeline batch checkpoint status=nominal bytes=4096`);
  }
  logLines.push(`[2026-11-11T12:00:01Z] [ERROR] ${SPILL_ERROR_CODE}: corrupted WAL segment header in partition-7`);
  for (let i = 222; i <= 450; i++) {
    logLines.push(`[2026-11-11T12:00:02Z] [INFO] worker-${String(i).padStart(3, "0")} post-run telemetry flush completed status=nominal bytes=4096`);
  }
  writeFileSync(spillFixturePath, logLines.join("\n") + "\n", "utf8");

  const data = await runTurn(
    ctx,
    sessionId,
    "Execute the bare command `cat pipeline_run.log` using the `bash` tool (no pipes, no `grep`, and do NOT use `read`), then report the exact `FATAL_LSM_SPILL_CODE_...` error identifier from the output.",
  );
  const msgs = data?.session?.messages || [];
  assert(hasToolCall(msgs, "bash"), "model must run bash tool");
  assert(assistantHasText(msgs, SPILL_ERROR_CODE), `model reply must report ${SPILL_ERROR_CODE} from middle of >25KB output`);

  // Verify <daemonDir>/brain/<sessionId>/tool-*.log exists on disk with full >25KB bytes!
  const sessionBrainDir = path.join(ctx.daemonDir, "brain", sessionId);
  const brainFiles = await fs.readdir(sessionBrainDir).catch(() => [] as string[]);
  const toolLogs = brainFiles.filter((f) => /^tool-.*\.log$/.test(f));
  log("spill", `brain/${sessionId} files: ${JSON.stringify(brainFiles)}`);
  assert(toolLogs.length >= 1, `expected at least one tool-*.log in ${sessionBrainDir}, got ${JSON.stringify(brainFiles)}`);

  const spillFullPath = path.join(sessionBrainDir, toolLogs[0]!);
  const spillContent = await fs.readFile(spillFullPath, "utf8");
  log("spill", `${toolLogs[0]} bytes=${Buffer.byteLength(spillContent, "utf8")}`);
  assert(Buffer.byteLength(spillContent, "utf8") > 25000, `expected >25KB full lossless spill file, got ${Buffer.byteLength(spillContent, "utf8")} bytes`);
  assert(spillContent.includes(SPILL_ERROR_CODE), "spilled log on disk must contain the middle error line");
  assert(spillContent.includes("worker-001") && spillContent.includes("worker-450"), "spilled log on disk must be 100% lossless from first to last line");

  const { browser, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    assertNoPageErrors(pageErrors, consoleErrors, "spill-ui");
  } finally {
    await browser.close();
  }
  log("test", "scenario 2 PASS (foreground >25KB spill to brain/tool-*.log + middle error survival)");
}

// 3. In-Process Read-Only `explore` Subagent
async function scenarioExploreSubagent(ctx: any) {
  log("test", "scenario 3: in-process read-only explore subagent");
  const modDir = path.join(ctx.workDir, "subsys");
  mkdirSync(path.join(modDir, "alpha"), { recursive: true });
  mkdirSync(path.join(modDir, "beta"), { recursive: true });
  mkdirSync(path.join(modDir, "gamma"), { recursive: true });

  const ALPHA_KEY = "EXPLORE_ALPHA_PORT_7731";
  const BETA_KEY = "EXPLORE_BETA_CODEC_LZ4X";
  const GAMMA_KEY = "EXPLORE_GAMMA_QUORUM_9";
  writeFileSync(path.join(modDir, "alpha", "server.ts"), `export const LISTEN_SPEC = "${ALPHA_KEY}";\n`, "utf8");
  writeFileSync(path.join(modDir, "beta", "codec.ts"), `export const WIRE_CODEC = "${BETA_KEY}";\n`, "utf8");
  writeFileSync(path.join(modDir, "gamma", "consensus.ts"), `export const MIN_QUORUM = "${GAMMA_KEY}";\n`, "utf8");

  const sessionId = await createAgenticSession(ctx, "e2e lsm explore subagent");

  const data = await runTurn(
    ctx,
    sessionId,
    "Delegate an investigation using the `explore` tool (do NOT call `read` or `glob` directly yourself) to inspect all TypeScript files under `subsys/` and collect the exact values of `LISTEN_SPEC`, `WIRE_CODEC`, and `MIN_QUORUM`. Report all three values verbatim.",
  );
  const msgs = data?.session?.messages || [];
  assert(hasToolCall(msgs, "explore"), "main agent must invoke the explore subagent tool");
  assert(assistantHasText(msgs, ALPHA_KEY), `explore findings missing ${ALPHA_KEY}`);
  assert(assistantHasText(msgs, BETA_KEY), `explore findings missing ${BETA_KEY}`);
  assert(assistantHasText(msgs, GAMMA_KEY), `explore findings missing ${GAMMA_KEY}`);

  const { browser, page, pageErrors, consoleErrors } = await openSessionPage(ctx, sessionId);
  try {
    await page.screenshot({ path: path.join(tmpdir(), "lsm-explore.png"), fullPage: false });
    assertNoPageErrors(pageErrors, consoleErrors, "explore-ui");
  } finally {
    await browser.close();
  }
  log("test", "scenario 3 PASS (explore subagent multi-file lookup + 0 page errors)");
}

const only = (process.argv[2] || "").toLowerCase();
const runAll = !only || only === "all";
try {
  const ctx = await boot();
  if (runAll || only === "eras" || only === "rewind") {
    await scenarioErasRecallAndRewind(ctx, {
      runErasAndRecall: runAll || only === "eras",
      runRewind: runAll || only === "rewind",
    });
  }
  if (runAll || only === "spill") await scenarioArrivalSpill(ctx);
  if (runAll || only === "explore") await scenarioExploreSubagent(ctx);
  console.log("\n=== RESULT ===\nPASS: indirect LSM context E2E complete");
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) {
    try {
      p.kill();
    } catch {}
  }
}
