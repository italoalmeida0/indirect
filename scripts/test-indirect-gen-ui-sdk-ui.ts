/**
 * Deterministic real-browser Playwright gate for Generative UI:
 *  - Keyed dynamic composer attachments (in-place update, static snapshot, PNG canvas snapshot, detach & chip removal sync)
 *  - Embedded AI SDK (mount-time guard, session model/effort inheritance, agent-authored model/effort pickers, streaming, JSON parsing, abort, live context sync)
 *  - Desktop (1440x900) and Mobile (390x844) layout & zero overflow checks
 *
 * Usage:
 *   PLAYWRIGHT_MODULE=... CHROMIUM_PATH=... bun scripts/test-indirect-gen-ui-sdk-ui.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "../plugins/solid-plugin";
import iconifyPlugin from "../plugins/iconify-solid-plugin";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "indirect-genui-sdk-ui-"));
process.env.DATA_DIR = DATA_DIR;
process.env.INDIRECT_SKIP_VOICE_MODEL_DOWNLOAD = "1";
process.env.GATEWAY_SECRET ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { db } = await import("../server/db");
const { insertSessionRow, prepareSessionTokens } = await import("../server/auth");
const { encryptSecret, randomToken, sha256Hex } = await import("../server/crypto");
const { GATEWAY_SECRET } = await import("../server/config");
const { insertPreparedKey, prepareKey } = await import("../server/keys");
const { invalidateModelCache } = await import("../server/models");
const { handleGenUiRoute } = await import("../server/routes/gen-ui");
const { vendorGenUiLibs } = await import("./vendor-gen-ui-libs");

await vendorGenUiLibs();

// Bundle the real SolidJS fixture using our exact production plugins.
const bundled = await Bun.build({
  entrypoints: [path.join(ROOT, "test", "fixtures", "gen-ui-sdk-ui.tsx")],
  target: "browser",
  plugins: [iconifyPlugin, solidPlugin],
});
if (!bundled.success) throw new Error(bundled.logs.map((l) => l.message).join("\n"));
const fixtureJs = await bundled.outputs[0]!.text();

const WIDGET_TSX = `
import { useState, useEffect, useRef } from "react";

export default function App(props) {
  const [aiCtx, setAiCtx] = useState(() => window.__gu.ai.getContext());
  const [atts, setAtts] = useState(() => window.__gu.getAttachments());
  const [player, setPlayer] = useState(props.player || "Ada");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [mountError, setMountError] = useState("");
  const [streamOut, setStreamOut] = useState("");
  const [reasoningOut, setReasoningOut] = useState("");
  const [jsonOut, setJsonOut] = useState("");
  const [abortState, setAbortState] = useState("");
  const [busy, setBusy] = useState(false);
  const activeReqRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const u1 = window.__gu.ai.onContextChange(setAiCtx);
    const u2 = window.__gu.onAttachmentsChange(setAtts);
    // Intentionally attempt an unprompted mount-time AI call to prove the host guard blocks it.
    window.__gu.ai.complete({ prompt: "auto mount call" }).catch((err) => {
      setMountError(String(err.code || err.message));
    });
    const c = canvasRef.current;
    if (c) {
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#14b8a6";
      ctx.fillRect(0, 0, 64, 64);
    }
    return () => { u1(); u2(); window.__gu.ai.abort(); };
  }, []);

  const isAttached = atts.some((a) => a.key === "intake");

  const attachDynamic = () => {
    window.__gu.attach({
      key: "intake",
      name: "intake.json",
      content: { player, model: selectedModel || aiCtx.model, effort: selectedEffort || aiCtx.effort },
    });
  };
  const attachStatic = () => {
    window.__gu.attach({ name: "snapshot.txt", content: "Static note for " + player });
  };
  const attachCanvas = () => {
    const du = canvasRef.current ? canvasRef.current.toDataURL("image/png") : "";
    window.__gu.attach({ key: "sketch", name: "board.png", dataUrl: du });
  };
  const detachDynamic = () => {
    window.__gu.detach("intake");
  };

  const askStream = async () => {
    setBusy(true);
    setStreamOut("");
    setReasoningOut("");
    try {
      const req = window.__gu.ai.stream({
        prompt: "Greet " + player,
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
        onToken: (_d, full) => setStreamOut(full),
        onReasoning: (_d, full) => setReasoningOut(full),
      });
      activeReqRef.current = req;
      await req;
    } catch (e) {
      setStreamOut("ERR:" + String(e.message));
    } finally {
      activeReqRef.current = null;
      setBusy(false);
    }
  };

  const askJson = async () => {
    setBusy(true);
    try {
      const res = await window.__gu.ai.json({
        prompt: "Make chess move",
        model: selectedModel || undefined,
        effort: selectedEffort || undefined,
      });
      setJsonOut(res.data.move + "|" + res.model + "|" + res.effort);
    } catch (e) {
      setJsonOut("ERR:" + String(e.message));
    } finally {
      setBusy(false);
    }
  };

  const startSlow = () => {
    setAbortState("running");
    const req = window.__gu.ai.stream({
      prompt: "SLOW_STREAM",
      onToken: (_d, full) => setAbortState("streaming:" + full),
    });
    activeReqRef.current = req;
    req.catch((e) => {
      setAbortState(e.aborted ? "aborted" : "err:" + e.message);
    });
  };

  const stopReq = () => {
    if (activeReqRef.current) activeReqRef.current.abort();
  };

  return (
    <div className="gu-root gu-stack">
      <div className="gu-header">
        <h2 className="gu-title">AI & Attach Demo</h2>
        <p className="gu-caption" data-testid="ctx-line">
          {aiCtx.model}|{aiCtx.effort}|{aiCtx.models.length}
        </p>
      </div>
      <div data-testid="mount-guard">{mountError}</div>
      <div className="gu-grid-2">
        <label className="gu-field">
          <span>Player</span>
          <input data-testid="player-input" className="gu-input" value={player} onChange={(e) => setPlayer(e.target.value)} />
        </label>
        <label className="gu-field">
          <span>Model</span>
          <select data-testid="model-select" className="gu-select" value={selectedModel} onChange={(e) => setSelectedModel(e.target.value)}>
            <option value="">Session default ({aiCtx.modelName})</option>
            {aiCtx.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="gu-field">
          <span>Effort</span>
          <select data-testid="effort-select" className="gu-select" value={selectedEffort} onChange={(e) => setSelectedEffort(e.target.value)}>
            <option value="">Session default ({aiCtx.effort})</option>
            {aiCtx.efforts.map((ef) => <option key={ef.id} value={ef.id}>{ef.label}</option>)}
          </select>
        </label>
      </div>
      <canvas ref={canvasRef} width={64} height={64} style={{ width: 32, height: 32 }} />
      <div className="gu-row">
        <button data-testid="btn-attach" className="gu-btn-primary" onClick={attachDynamic}>
          {isAttached ? "Update Form" : "Attach Form"}
        </button>
        <button data-testid="btn-detach" className="gu-btn" onClick={detachDynamic}>Detach Form</button>
        <button data-testid="btn-static" className="gu-btn" onClick={attachStatic}>Attach Static</button>
        <button data-testid="btn-canvas" className="gu-btn" onClick={attachCanvas}>Attach Canvas</button>
      </div>
      <div className="gu-row">
        <button data-testid="btn-stream" className="gu-btn-primary" disabled={busy} onClick={askStream}>Ask Stream</button>
        <button data-testid="btn-json" className="gu-btn" disabled={busy} onClick={askJson}>Ask JSON</button>
        <button data-testid="btn-slow" className="gu-btn" onClick={startSlow}>Start Slow</button>
        <button data-testid="btn-stop" className="gu-btn" onClick={stopReq}>Stop</button>
      </div>
      <div data-testid="stream-out">{streamOut}</div>
      <div data-testid="reasoning-out">{reasoningOut}</div>
      <div data-testid="json-out">{jsonOut}</div>
      <div data-testid="abort-state">{abortState}</div>
      <div data-testid="att-count">{atts.length}</div>
    </div>
  );
}
`;

// 1. Start fake OpenAI upstream
const seenUpstream: Array<Record<string, unknown>> = [];
const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Record<string, unknown>;
    seenUpstream.push(body);
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = String(msgs.at(-1)?.content ?? "");
    const enc = new TextEncoder();

    if (body.stream === true && last.includes("SLOW_STREAM")) {
      const stream = new ReadableStream({
        async start(c) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                id: "s_slow",
                model: body.model,
                choices: [{ index: 0, delta: { content: "Tick1" }, finish_reason: null }],
              })}\n\n`,
            ),
          );
          await Bun.sleep(5000);
          try {
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          } catch {}
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }

    if (body.stream === true) {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                id: "s1",
                model: body.model,
                choices: [{ index: 0, delta: { reasoning_content: "Deep plan." }, finish_reason: null }],
              })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                id: "s1",
                model: body.model,
                choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }],
              })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                id: "s1",
                model: body.model,
                choices: [{ index: 0, delta: { content: last.replace("Greet ", "") + "!" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 15, completion_tokens: 4 },
              })}\n\n`,
            ),
          );
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    }

    return new Response(
      JSON.stringify({
        id: "j1",
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: '```json\n{"move":"e7e5"}\n```' },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

// 2. Seed SQLite user + session + host + models
const now = Date.now();
const userId = `u_pw_${randomToken(6)}`;
db.prepare(
  "INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, 'PW User', 'user', 'active', ?)",
).run(userId, `${userId}@test.local`, now);
const userRow = db.prepare<any, [string]>("SELECT * FROM users WHERE id = ?").get(userId)!;
const tokens = await prepareSessionTokens(userRow);
insertSessionRow(userId, tokens);

const encKey = await encryptSecret("sk-pw-fake", GATEWAY_SECRET);
const provId = `prov_pw_${randomToken(6)}`;
db.prepare(
  "INSERT INTO providers (id, name, openai_base_url, openai_auth_style, api_key_enc, enabled, priority, created_at) VALUES (?, 'Fake', ?, 'bearer', ?, 1, 1, ?)",
).run(provId, `http://127.0.0.1:${upstream.port}/v1`, encKey, now);
db.prepare(
  "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 1, 'active', ?, ?)",
).run(`pk_pw_${randomToken(6)}`, provId, encKey, now, now);

const models = [
  { id: "deepseek-reasoner", name: "DeepSeek Reasoner", provider: "Fake", upstreamModel: "deepseek-reasoner", context: 128000, output: 8192 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "Fake", upstreamModel: "gpt-4o-mini", context: 128000, output: 4096 },
];
for (const m of models) {
  db.prepare(
    "INSERT INTO models (id, name, provider_id, upstream_model, context_length, max_output_length, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).run(m.id, m.name, provId, m.upstreamModel, m.context, m.output, now, now);
  db.prepare(
    "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, 1, 1, ?)",
  ).run(m.id, provId, m.upstreamModel, now);
}
invalidateModelCache();

const prepKey = await prepareKey(userId, { name: "Daemon: PW" });
const keyRow = insertPreparedKey(prepKey, now);
const hostId = `host_pw_${randomToken(6)}`;
db.prepare(
  "INSERT INTO remote_hosts (id, user_id, name, hostname, os, arch, daemon_token_hash, api_key_id, status, last_seen_at, created_at) VALUES (?, ?, 'PW PC', 'pw', 'linux', 'amd64', ?, ?, 'online', ?, ?)",
).run(hostId, userId, sha256Hex(`dmt_${randomToken(12)}`), keyRow.id, now, now);

// 3. Serve the fixture + real handleGenUiRoute on one origin
const hostServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/indirect-code/gen-ui/")) {
      const res = await handleGenUiRoute(url.pathname, req, url, srv);
      if (res) return res;
    }
    if (url.pathname === "/bundle.js") {
      return new Response(fixtureJs, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    }
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
      <div id="root"></div>
      <script>
        localStorage.setItem("cache_code_session", ${JSON.stringify(
          JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: { id: userId, email: userRow.email, name: userRow.name, role: "user", status: "active", hasPassword: false, googleLinked: false, totpEnabled: false, createdAt: now } }),
        )});
        window.__FIXTURE_HOST_ID__ = ${JSON.stringify(hostId)};
        window.__FIXTURE_MODELS__ = ${JSON.stringify(models)};
        window.__FIXTURE_WIDGET_SOURCE__ = ${JSON.stringify(WIDGET_TSX)};
      </script>
      <script type="module" src="/bundle.js"></script>
    </body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  const consoleMsgs: string[] = [];
  page.on("pageerror", (e: Error) => { pageErrors.push(String(e)); console.error("[pageerror]", e); });
  page.on("console", (msg: any) => { consoleMsgs.push(`[${msg.type()}] ${msg.text()}`); if (msg.type() === "error") console.error("[console.error]", msg.text()); });

  await page.goto(hostServer.url.toString(), { waitUntil: "networkidle" });
  const frame = page.frameLocator('iframe[sandbox="allow-scripts"]').first();

  // 1. Live session context arrives immediately & mount-time AI call is blocked!
  try {
    await frame.getByTestId("ctx-line").waitFor({ state: "visible", timeout: 10_000 });
  } catch (e) {
    console.error("[DEBUG] body HTML:", await page.locator("body").innerHTML());
    console.error("[DEBUG] console:", consoleMsgs);
    throw e;
  }
  await page.waitForFunction(
    () => {
      const f = document.querySelector("iframe") as HTMLIFrameElement | null;
      return !!f;
    },
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);
  const ctxText = await frame.getByTestId("ctx-line").textContent();
  assert.equal(ctxText, "deepseek-reasoner|medium|2", `unexpected initial AI context: ${ctxText}`);
  const mountGuard = await frame.getByTestId("mount-guard").textContent();
  assert.equal(mountGuard, "interaction_required", `mount-time AI call should be blocked, got: ${mountGuard}`);
  assert.equal(seenUpstream.length, 0, "no upstream AI call should happen on mount");

  // 2. Dynamic keyed attachment -> in-place update -> static -> canvas PNG -> preview -> remove chip sync
  await frame.getByTestId("btn-attach").click();
  await page.locator('[data-widget-attachment="intake"]').waitFor({ state: "visible", timeout: 5000 });
  assert.equal(await frame.getByTestId("btn-attach").textContent(), "Update Form");
  assert.equal(await frame.getByTestId("att-count").textContent(), "1");

  // Edit player name and click Update Form -> STILL 1 chip, updated in place!
  await frame.getByTestId("player-input").fill("Grace Hopper");
  await frame.getByTestId("btn-attach").click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-widget-attachment="intake"]').count(), 1);
  const attsAfterUpdate: any[] = await page.evaluate(() => window.__sdkFixture!.getAttachments());
  assert.equal(attsAfterUpdate.length, 1);
  assert.ok(attsAfterUpdate[0].text.includes("Grace Hopper"), "keyed attachment should update in-place");

  // Preview modal opens and displays updated payload
  await page.locator('[data-widget-attachment="intake"] button').first().click();
  await page.getByText("Grace Hopper").first().waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);

  // Add static attachment + PNG canvas attachment
  await frame.getByTestId("btn-static").click();
  await frame.getByTestId("btn-canvas").click();
  await page.waitForTimeout(200);
  assert.equal(await frame.getByTestId("att-count").textContent(), "3");
  const allAtts: any[] = await page.evaluate(() => window.__sdkFixture!.getAttachments());
  assert.equal(allAtts.length, 3);
  assert.equal(allAtts.find((a) => a.widgetSlot === "sketch")?.mime, "image/png");

  // Remove the keyed chip from the Composer X button -> widget syncs back to "Attach Form"
  await page.locator('[data-widget-attachment="intake"] button[aria-label^="Remove"]').click();
  await page.waitForTimeout(200);
  assert.equal(await frame.getByTestId("btn-attach").textContent(), "Attach Form");
  assert.equal(await frame.getByTestId("att-count").textContent(), "2");

  // 3. Embedded AI streaming using inherited session model & effort
  await frame.getByTestId("btn-stream").click();
  await page.waitForFunction(
    () => true,
    undefined,
    { timeout: 5000 },
  );
  await frame.getByTestId("stream-out").filter({ hasText: "Hello Grace Hopper!" }).waitFor({ timeout: 10_000 });
  assert.equal(await frame.getByTestId("reasoning-out").textContent(), "Deep plan.");
  assert.equal(seenUpstream.at(-1)?.model, "deepseek-reasoner");
  assert.equal(seenUpstream.at(-1)?.reasoning_effort, "medium");

  // 4. Agent-authored model + effort picker override + ai.json()
  await frame.getByTestId("model-select").selectOption("gpt-4o-mini");
  await frame.getByTestId("effort-select").selectOption("high");
  await frame.getByTestId("btn-json").click();
  await frame.getByTestId("json-out").filter({ hasText: "e7e5|gpt-4o-mini|high" }).waitFor({ timeout: 10_000 });
  assert.equal(seenUpstream.at(-1)?.model, "gpt-4o-mini");
  // gpt-4o-mini is non-reasoning so target-profile strips reasoning_effort cleanly!
  assert.equal(seenUpstream.at(-1)?.reasoning_effort, undefined);

  // 5. Live host model/effort change propagates into widget via onContextChange
  await page.evaluate(() => {
    window.__sdkFixture!.setModel("gpt-4o-mini");
    window.__sdkFixture!.setEffort("max");
  });
  await frame.getByTestId("ctx-line").filter({ hasText: "gpt-4o-mini|max|2" }).waitFor({ timeout: 5000 });

  // 6. Abort in-flight stream cleanly via req.abort()
  await frame.getByTestId("btn-slow").click();
  await frame.getByTestId("abort-state").filter({ hasText: "streaming:Tick1" }).waitFor({ timeout: 5000 });
  await frame.getByTestId("btn-stop").click();
  await frame.getByTestId("abort-state").filter({ hasText: "aborted" }).waitFor({ timeout: 5000 });

  // 7. Mobile 390x844 layout & zero horizontal overflow
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(mobileOverflow, false, "host page overflowed horizontally at 390px");
  const frameOverflow = await frame.locator("body").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  assert.equal(frameOverflow, false, "widget iframe overflowed horizontally at 390px");

  assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join("; ")}`);
  console.log("PASS: test-indirect-gen-ui-sdk-ui (desktop + mobile, attach + embedded AI)");
} finally {
  await browser.close();
  hostServer.stop(true);
  upstream.stop(true);
  try {
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
}
