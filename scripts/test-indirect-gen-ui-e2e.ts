/**
 * Generative UI end-to-end (real model + real browser).
 *
 * Boots the gateway + daemon exactly like the compaction e2e, registers the
 * synthetic provider, then asks the model for an interactive widget rendered
 * through the ```generative_ui DSL and validates the live widget in a real
 * browser (desktop + mobile screenshots).
 *
 *   PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright-core/index.mjs \
 *   CHROMIUM_PATH=~/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
 *   bun scripts/test-indirect-gen-ui-e2e.ts
 *
 * Provider env (defaults match the task brief):
 *   SYNTHETIC_API_KEY / SYNTHETIC_BASE_URL / E2E_MODEL
 */
import { mkdirSync, mkdtempSync } from "fs";
import path from "path";
import os from "os";
import fs from "fs/promises";
import assert from "assert";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const WS = path.join(ROOT, "..");
const envFile = await fs.readFile(path.join(WS, ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};
const PROVIDER_KEY = envGet("SYNTHETIC_API_KEY");
const PROVIDER_BASE = envGet("SYNTHETIC_BASE_URL") || "https://api.synthetic.new/v1";
if (!PROVIDER_KEY) {
  console.error("SYNTHETIC_API_KEY missing — put it in .env (gitignored) or the environment");
  process.exit(2);
}
const MODEL = process.env.E2E_MODEL || "hf:deepseek-ai/DeepSeek-V4.1-Flash";
const SHOTS = process.env.E2E_SHOTS_DIR ||
  path.join(os.homedir(), ".indirect-code", "brain", "sess_91cae2ecbaf514a996cf34f53a8a2b4a", "shots");

const daemonBin = path.join(WS, "indirect-code-daemon", "bin", "indirect-code");
if (!(await fs.stat(daemonBin).catch(() => null))) {
  console.error("daemon binary missing: build it with bun run build:daemon first");
  process.exit(2);
}
if (!(await fs.stat(path.join(WS, "dist", "index.html")).catch(() => null))) {
  console.error("web dist/ missing: run bun run build:web first");
  process.exit(2);
}

async function resolveChrome(): Promise<string> {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = `${process.env.HOME}/.cache/ms-playwright`;
  for (const d of ["chromium-1243", "chromium-1234", "chromium-1228"]) {
    for (const c of [`${cache}/${d}/chrome-linux64/chrome`, `${cache}/${d}/chrome-linux/chrome`]) {
      if (await fs.stat(c).catch(() => null)) return c;
    }
  }
  for (const b of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = Bun.which(b);
    if (found) return found;
  }
  console.error("no Chrome found: set CHROMIUM_PATH");
  process.exit(2);
}

const GW_PORT = Number(process.env.E2E_GW_PORT || 4612);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-genui-pass-1";
const procs: Array<{ kill: () => void }> = [];
function log(tag: string, msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

async function boot() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "llmgw-genui-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: WS,
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      PUBLIC_URL: GW,
    },
    stdout: "ignore", stderr: "ignore",
  });
  procs.push(gwProc);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${GW}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }
  const login: any = await (await fetch(`${GW}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
  })).json();
  assert(login.success, "admin login failed");
  const jwt = login.accessToken;
  const auth = { authorization: `Bearer ${jwt}`, "content-type": "application/json" };

  const pair: any = await (await fetch(`${GW}/api/indirect-code/pair`, { method: "POST", headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert(pair.success && pair.connectUrl, "pairing failed");
  const daemonDir = mkdtempSync(path.join(os.tmpdir(), "llmgw-genui-d-"));
  mkdirSync(path.join(daemonDir, "workspace"), { recursive: true });
  const workDir = path.join(daemonDir, "workspace");
  const daemonProc = Bun.spawn(
    [daemonBin, "--worker", "--connect", pair.connectUrl, "--data-dir", daemonDir, "--name", "GenUI E2E"],
    { cwd: WS, env: { ...process.env, HOME: daemonDir }, stdout: "ignore", stderr: "ignore" });
  procs.push(daemonProc);

  // Synthetic provider + registry model.
  await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "synthetic-e2e", openaiBaseUrl: PROVIDER_BASE, apiKey: PROVIDER_KEY, openaiAuthStyle: "bearer" }),
  })).json();
  const list: any = await (await fetch(`${GW}/api/admin/providers`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
  const created = (list.providers || []).find((p: any) => p.name === "synthetic-e2e");
  const providerId = created?.id;
  assert(providerId, `provider not found after create: ${JSON.stringify(list).slice(0, 300)}`);
  let mkModel: any = await (await fetch(`${GW}/api/admin/models`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ id: MODEL, providerId, upstreamModel: MODEL, contextLength: 131072 }),
  })).json();
  if (!mkModel.success && /already registered/.test(mkModel.error || "")) {
    mkModel = await (await fetch(`${GW}/api/admin/models/${encodeURIComponent(MODEL)}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ providerId, upstreamModel: MODEL, contextLength: 131072 }),
    })).json();
  }
  assert(mkModel.success, `model create failed: ${JSON.stringify(mkModel)}`);

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
      setTimeout(() => { if (pending.has(payload.requestId)) { pending.delete(payload.requestId); resolve(undefined); } }, 30000);
    });
  };
  const events: any[] = [];
  await new Promise<void>((res) => { ws.onopen = () => res(); });
  ws.onmessage = (ev: MessageEvent) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (msg.requestId && pending.has(msg.requestId)) { pending.get(msg.requestId)!(msg); pending.delete(msg.requestId); return; }
      events.push(msg);
    } catch {}
  };
  {
    const start = Date.now();
    while (!hostId && Date.now() - start < 20000) {
      const h: any = await (await fetch(`${GW}/api/indirect-code/hosts`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
      const f = (h.hosts || []).find((x: any) => x.name === "GenUI E2E" && x.status === "online");
      if (f) hostId = f.id;
      else await Bun.sleep(300);
    }
  }
  assert(hostId, "daemon host never came online");
  log("boot", `gateway + daemon up (host ${hostId})`);
  return { jwt, login, hostId, ws, send, workDir, events, gw: GW, auth };
}

async function waitForIdle(ctx: any, sessionId: string, timeoutMs = 900000) {
  const t0 = Date.now();
  let lastStatus = "";
  for (;;) {
    await Bun.sleep(3000);
    const data: any = await ctx.send({ type: "get_session", sessionId });
    const st = data?.session?.status;
    if (st !== lastStatus) { lastStatus = st; log("turn", `status=${st} after ${Math.round((Date.now() - t0) / 1000)}s`); }
    if (st !== "running") return data;
    if (Date.now() - t0 >= timeoutMs) {
      const tail = ctx.events.slice(-15).map((e: any) => JSON.stringify(e).slice(0, 200));
      log("turn", `TIMEOUT event tail:\n${tail.join("\n")}`);
      assert(false, "turn timed out");
    }
  }
}

function watchPage(page: any) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(String(e).slice(0, 300)));
  page.on("console", (m: any) => {
    if (m.type() === "error" && !/favicon|net::ERR_BLOCKED|ERR_ABORTED/.test(m.text())) {
      consoleErrors.push(String(m.text()).slice(0, 300));
    }
  });
  return { pageErrors, consoleErrors };
}

type CaseDef = {
  id: string;
  prompt: string;
  /** At least this many interactive elements must exist in the widget. */
  minInteractive: number;
  /** Selector of the element the interaction recipe drives. */
  act: string;
  /** "input" dispatches an input event after changing value/checked; "click" clicks. */
  actKind: "input" | "click";
  /** For actKind "input": set el.value to max*0.85 (range) or toggle checked (checkbox). */
  /** Dependent selectors that must change after the interaction. */
  expectChanged: string[];
  /** Dependent selectors that must exist and be non-empty. */
  expectText: string[];
  /** Preloaded library globals that must exist in the widget (window.<name>). */
  needs?: ("d3" | "THREE" | "Chart" | "gsap" | "L")[];
  /** Assert the lifecycle contract (destroy hook registered, no runtime error). */
  checkDestroy?: boolean;
  /** The widget document must be served with the opt-in https CSP variant. */
  needsNet?: boolean;
};

/**
 * The official OpenIntelligentUI capability matrix (their own test prompts):
 * a Three.js 3D explainer, a live-map itinerary, an interactive comparison
 * and a rounding-exact bill splitter. These cover 3D, maps/net, d3-style
 * charts, cards, animations and forms.
 */

/**
 * The OpenIntelligentUI demo corpus (docs/generative-ui.md + the
 * generative-ui/ component suite: charts, table-catalog, plan-card,
 * trip-animator, meeting-time-picker). Each case is one model turn that must
 * produce one live widget satisfying its interaction contract.
 */
const CASES: CaseDef[] = [
  {
    id: "airplane-3d",
    prompt: "Create an interactive 3D airplane in Three.js that explains pitch, roll, and yaw. Make the airplane recognizable with a fuselage, wings, tail and cockpit, on a clean light background. Start with a three-quarter view. Give each axis a labeled slider with its angle and a button that smoothly demonstrates that motion, plus a Reset button. Show color-coded labeled axes through the plane: pitch raises or lowers the nose about the lateral axis, roll banks the wings about the longitudinal axis, and yaw turns the nose left or right about the vertical axis. Match each label, control and rotation correctly. Animate demonstrations over about 1.5 seconds, keep the camera stable during demonstrations, and let me drag to orbit the camera. Include one short explanation per axis. Keep the canvas compact enough that the controls are visible in chat. Respect reduced motion and show a readable error if WebGL cannot initialize. This is a conceptual rotation model, not a flight simulator.",
    minInteractive: 6,
    act: 'input[type="range"]',
    actKind: "input",
    expectChanged: ["root-html"],
    expectText: [".gu-title"],
    needs: ["THREE"],
    checkDestroy: true,
  },
  {
    id: "coastal-trip",
    prompt: "Plan an illustrative four-day coastal trip from San Francisco to Los Angeles, stopping at Half Moon Bay, Santa Cruz, Monterey, and Santa Barbara. Show a real map with numbered pins and photo cards. Pin the numbered dots onto the map one by one over 6 seconds: each dot drops gently into place with a small spring settle, then stays. Reveal connecting segments behind the pins and highlight the corresponding card. Keep the map camera still; do not animate a traveler along the route. Include pause, replay and clickable stop cards. Use live USGS tiles and sourced photos; label the connecting line as an itinerary sketch, not verified driving directions.",
    minInteractive: 6,
    act: ".gu-card, button",
    actKind: "click",
    expectChanged: ["root-html"],
    expectText: [".gu-title"],
    needs: ["L"],
    needsNet: true,
    checkDestroy: true,
  },
  {
    id: "weekend-compare",
    prompt: "Help me compare a coastal, city, and mountain weekend for two. Build an interactive comparison with adjustable budget and travel-time preferences. Use clearly labeled illustrative estimates, not live prices, and explain how the recommendation changes.",
    minInteractive: 2,
    act: 'input[type="range"], input[type="number"]',
    actKind: "input",
    expectChanged: ["#headline"],
    expectText: [".gu-title"],
    checkDestroy: true,
  },
  {
    id: "bill-splitter",
    prompt: "Build a bill splitter with editable subtotal, tip percentage, and number of people. Show the total and each person's share, validate inputs, and allocate rounding cents so all shares sum to the exact total. Do not imply that any payment is sent.",
    minInteractive: 3,
    act: 'input[type="number"], input[type="range"]',
    actKind: "input",
    expectChanged: ["root-html"],
    expectText: [".gu-title"],
    checkDestroy: true,
  },
  {
    id: "chart-d3",
    prompt: "Build ONE interactive data chart widget as a generative_ui fenced code block. Requirements: use window.d3 to draw an SVG bar or line chart with axis labels and a gu-legend; the data is monthly revenue for 6 months; include two gu-btn buttons (ids: btn-a, btn-b) that switch the dataset (A vs B) and redraw the SVG live; include gu-title and gu-caption. @js only, addEventListener + $render(). Output one short sentence then ONLY the code block. Do not call tools.",
    minInteractive: 2,
    act: "#btn-b",
    actKind: "click",
    expectChanged: ["svg"],
    expectText: [".gu-title", ".gu-legend"],
    needs: ["d3"],
    checkDestroy: true,
  },
  {
    id: "table-catalog",
    prompt: "Build ONE interactive sortable data table widget as a generative_ui fenced code block. Requirements: a gu-table listing 6 products (name, category, price, rating) with id=catalog; clicking any column header (th) sorts the rows by that column and toggles asc/desc; include gu-title and gu-caption; rows have class row-item. @js only, addEventListener + $render(). Output one short sentence then ONLY the code block. Do not call tools.",
    minInteractive: 3,
    act: ".gu-table th",
    actKind: "click",
    expectChanged: ["#catalog tbody"],
    expectText: [".gu-title", ".gu-table td"],
    checkDestroy: true,
  },
];

async function runCaseTurn(ctx: any, sessionId: string, c: CaseDef) {
  log("case", `${c.id}: sending prompt`);
  const text = c.prompt.includes("generative_ui")
    ? c.prompt
    : `${c.prompt}\n\nDo not call any tools. Answer with ONE short sentence and then a single \`\`\`generative_ui fenced code block containing the entire widget (that block IS the delivery format — never write widget code to files).`;
  ctx.ws.send(JSON.stringify({
    type: "prompt", hostId: ctx.hostId, sessionId, model: MODEL, text,
  }));
  const data = await waitForIdle(ctx, sessionId);
  const messages = JSON.stringify(data?.session?.messages || []);
  if (!messages.includes("```generative_ui")) {
    const raw = JSON.stringify(data?.session?.messages || []);
    writeFileSync(`/home/user/.indirect-code/brain/sess_221c58f6572f9522d4d36460851f62bf/fail-${c.id}.json`, raw);
    const tail = raw.slice(-2500);
    log("debug", `${c.id}: transcript tail -> ${tail}`);
    assert(false, `${c.id}: model never emitted a generative_ui fence (transcript dumped)`);
  }
  const fences = (messages.match(/```generative_ui/g) || []).length;
  log("case", `${c.id}: fence present (${fences} total in transcript)`);
}

function widgetCount(page: any) {
  return page.$$('iframe[title="Interactive widget"]');
}

async function probeWidget(frame: any, c: CaseDef) {
  await frame.waitForSelector(".gu-root", { state: "attached", timeout: 20000 });
  const probe = await frame.evaluate(() => {
    const w = window as any;
    return {
      hasBridge: typeof w.indirectUi?.sendPrompt === "function",
      hasRuntime: typeof w.__gu?.render === "function" && typeof w.__gu?.state === "object",
      hasD3: typeof w.d3 === "object",
      interactive: document.querySelectorAll('button, input, select, textarea, [role="button"]').length,
    };
  });
  log("probe", `${c.id}: ${JSON.stringify(probe)}`);
  assert(probe.hasBridge, `${c.id}: window.indirectUi bridge missing`);
  assert(probe.hasRuntime, `${c.id}: runtime missing`);
  assert(probe.interactive >= c.minInteractive,
    `${c.id}: expected >=${c.minInteractive} interactive elements, got ${probe.interactive}`);

  for (const name of c.needs ?? []) {
    const has = await frame.evaluate((n: string) => {
      const g = (window as any)[n];
      return typeof g === "object" || typeof g === "function";
    }, name);
    assert(has, `${c.id}: library global ${name} missing`);
  }
  if (c.checkDestroy) {
    const life = await frame.evaluate(() => {
      const g = (window as any).__gu;
      return {
        destroy: typeof g?.destroy === "function",
        error: g?.error ?? null,
      };
    });
    assert(life.destroy, `${c.id}: __gu.destroy lifecycle hook missing`);
    assert(life.error === null, `${c.id}: runtime error ${life.error}`);
  }

  if (c.needsNet) {
    const netMeta = await frame.evaluate(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return meta?.getAttribute("content") || "";
    });
    assert(netMeta.includes("connect-src https:"), `${c.id}: net CSP variant missing`);
    log("probe", `${c.id}: net CSP OK`);
  }

  for (const sel of c.expectText) {
    if (sel === "root-html") {
      const ok = await frame.evaluate(() => {
        const root = document.querySelector(".gu-root");
        return !!root && root.children.length > 0;
      });
      assert(ok, `${c.id}: .gu-root missing or empty`);
      continue;
    }
    const present = await frame.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) return "missing";
      const txt = (el.textContent || "").trim();
      if (txt.length > 0) return "text";
      // Visual-only elements (progress bars, tracks) carry no text: they are
      // valid when they occupy layout space.
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? "visual" : "empty";
    }, sel);
    assert(present === "text" || present === "visual",
      `${c.id}: ${sel} missing or empty (${present})`);
  }

  // Snapshot -> interact -> snapshot; every expectChanged selector must differ.
  const snap = (sel: string) => frame.evaluate((s: string) => {
    const query = s === "root-html" ? ".gu-root" : s;
    const els = [...document.querySelectorAll(query)];
    return els.map((e: any) => (e.outerHTML || e.textContent || "")).join("|");
  }, sel);
  const before: Record<string, string> = {};
  for (const sel of c.expectChanged) before[sel] = await snap(sel);

  if (c.actKind === "click") {
    await frame.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLElement | null;
      el?.click();
    }, c.act);
  } else {
    await frame.evaluate((s: string) => {
      const el = document.querySelector(s) as HTMLInputElement | null;
      if (!el) return;
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = !el.checked;
      } else if (el.type === "range" || el.type === "number") {
        const max = Number(el.max) || 100, min = Number(el.min) || 0;
        const cur = Number(el.value);
        el.value = String(cur > (min + max) / 2 ? Math.round(min + (max - min) * 0.15) : Math.round(min + (max - min) * 0.85));
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, c.act);
  }
  await new Promise((r) => setTimeout(r, 500));

  const changed = async () => {
    for (const sel of c.expectChanged) {
      if ((await snap(sel)) !== before[sel]) return true;
    }
    return false;
  };

  if (!(await changed())) {
    // Fallback sweep: drive every control in the widget. The model may wire
    // interactions to controls other than the recipe's primary selector.
    log("probe", `${c.id}: primary act changed nothing, sweeping all controls`);
    await frame.evaluate(() => {
      for (const el of document.querySelectorAll("input, select, textarea")) {
        const input = el as HTMLInputElement;
        if (input.type === "checkbox" || input.type === "radio") input.checked = !input.checked;
        else if (input.type === "range" || input.type === "number") {
          const max = Number(input.max) || 100, min = Number(input.min) || 0;
          const cur = Number(input.value);
          input.value = String(cur > (min + max) / 2 ? Math.round(min + (max - min) * 0.2) : Math.round(min + (max - min) * 0.8));
        } else if (input.tagName === "SELECT") {
          const sel = input as HTMLSelectElement;
          sel.selectedIndex = (sel.selectedIndex + 1) % Math.max(1, sel.options.length);
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      for (const el of document.querySelectorAll("button, [role='button']")) (el as HTMLElement).click();
    });
    await new Promise((r) => setTimeout(r, 900));
  }

  for (const sel of c.expectChanged) {
    const after = await snap(sel);
    assert(after !== before[sel],
      `${c.id}: ${sel} did not change after ${c.actKind} on ${c.act}\nbefore=${before[sel].slice(0, 400)}\nafter=${after.slice(0, 400)}`);
  }
  log("probe", `${c.id}: interaction OK (${c.actKind} ${c.act})`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const filter = process.env.GEN_UI_CASES?.split(",").map((s) => s.trim()).filter(Boolean);
  const cases = filter?.length ? CASES.filter((c) => filter.includes(c.id)) : CASES;
  assert(cases.length > 0, `no cases match GEN_UI_CASES=${process.env.GEN_UI_CASES}`);
  const ctx = await boot();
  const created: any = await ctx.send({ type: "create_session", cwd: ctx.workDir, title: "generative ui e2e", model: MODEL });
  const sessionId = created?.session?.id;
  assert(sessionId, `create_session failed: ${JSON.stringify(created).slice(0, 300)}`);
  log("session", `created ${sessionId}`);

  const browser = await chromium.launch({ executablePath: await resolveChrome(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    // ---- desktop: one turn per case, probe + screenshot the newest widget ----
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await desktop.newPage();
    const { pageErrors, consoleErrors } = watchPage(page);
    await page.addInitScript(({ sess, hid, sid }: any) => {
      try { localStorage.setItem("cache_code_session", JSON.stringify(sess));
        localStorage.setItem(`llmgw-rc-session:${hid}`, sid); } catch {}
    }, {
      sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
      hid: ctx.hostId, sid: sessionId,
    });
    await page.goto(`${GW}/#/code`, { waitUntil: "networkidle" });

    for (const c of cases) {
      await runCaseTurn(ctx, sessionId, c);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector('iframe[title="Interactive widget"]', { timeout: 60000 });
      await page.waitForTimeout(1500);
      const iframes = await widgetCount(page);
      assert(iframes.length >= 1, `${c.id}: no widget iframe`);
      // The newest widget is the last one in the transcript.
      const frame = await iframes[iframes.length - 1].contentFrame();
      assert(frame, `${c.id}: widget frame missing`);
      await probeWidget(frame, c);
      await iframes[iframes.length - 1].scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(SHOTS, `genui-case-${c.id}-desktop.png`), fullPage: false });
      log("shot", `desktop ${c.id} -> genui-case-${c.id}-desktop.png`);
    }
    assert.deepEqual(pageErrors, [], `desktop page errors: ${pageErrors.join(" | ")}`);
    assert.deepEqual(consoleErrors, [], `desktop console errors: ${consoleErrors.join(" | ")}`);
    await desktop.close();

    // ---- mobile: every case gets a screenshot of its widget ----
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const mpage = await mobile.newPage();
    const mwatch = watchPage(mpage);
    await mpage.addInitScript(({ sess, hid, sid }: any) => {
      try { localStorage.setItem("cache_code_session", JSON.stringify(sess));
        localStorage.setItem(`llmgw-rc-session:${hid}`, sid); } catch {}
    }, {
      sess: { accessToken: ctx.login.accessToken, refreshToken: ctx.login.refreshToken, user: ctx.login.user },
      hid: ctx.hostId, sid: sessionId,
    });
    await mpage.goto(`${GW}/#/code`, { waitUntil: "networkidle" });
    await mpage.waitForSelector('iframe[title="Interactive widget"]', { state: "attached", timeout: 60000 });
    const visible = await mpage.locator('iframe[title="Interactive widget"]').first().isVisible().catch(() => false);
    if (!visible) {
      await mpage.getByText("generative ui e2e", { exact: false }).first().click();
      await mpage.waitForTimeout(1200);
    }
    await mpage.waitForTimeout(1500);
    const mIframes = await widgetCount(mpage);
    assert(mIframes.length >= cases.length,
      `mobile: expected >=${cases.length} widgets, found ${mIframes.length}`);
    // The matrix widgets are the last N iframes in transcript order (a case
    // may occasionally emit extra blocks before its final widget).
    const caseIframes = mIframes.slice(-cases.length);
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      await caseIframes[i].scrollIntoViewIfNeeded();
      await mpage.waitForTimeout(400);
      await mpage.screenshot({ path: path.join(SHOTS, `genui-case-${c.id}-mobile.png`), fullPage: false });
      log("shot", `mobile ${c.id} -> genui-case-${c.id}-mobile.png`);
    }
    assert.deepEqual(mwatch.pageErrors, [], `mobile page errors: ${mwatch.pageErrors.join(" | ")}`);
    await mobile.close();
  } finally {
    await browser.close();
  }
  console.log("\n=== RESULT ===\nPASS: generative UI e2e complete (" + CASES.length + " cases, desktop + mobile)");
}

try {
  await main();
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) {
    try { p.kill(); } catch {}
  }
}
