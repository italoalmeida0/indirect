// Real-daemon check for the skills system: the config pull carries the
// generative_ui_agentic builtin (usable deny, agentic), skill files under
// <data-dir>/skills hot-reload with a "config" change ping, broken files
// surface as relative-path skillErrors, deletion removes the skill, the
// remembered lastSelection keeps the create/configure skill choice, and a
// capitalized /Compact is handled by the daemon instead of starting a model
// turn. No credentials or external network. Run:
//   DAEMON_BINARY=… bun scripts/test-indirect-skills-daemon.ts
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const binary = process.env.DAEMON_BINARY || join(import.meta.dir, "../indirect-code-daemon/bin/indirect-code.exe");

async function run() {
  const dir = mkdtempSync(join(tmpdir(), "daemon-skills-"));
  const work = join(dir, "work");
  const skills = join(dir, "skills");
  mkdirSync(work);
  mkdirSync(skills);
  const events: any[] = [];
  const requests: any[] = [];
  let socket: any;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, server) {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/daemon/ws")) {
        if (server.upgrade(req)) return;
        return new Response("bad ws", { status: 400 });
      }
      if (u.pathname === "/api/indirect-code/models") {
        return Response.json({ models: [{ id: "m", limit: { context: 1000000, output: 1024 } }] });
      }
      if (req.method === "POST" && u.pathname.endsWith("/messages")) {
        requests.push(await req.json());
        const items = [
          { type: "message_start", message: { id: "msg-skills", model: "m", role: "assistant", usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ];
        return new Response(items.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({ success: true });
    },
    websocket: {
      open(ws) {
        socket = ws;
      },
      message(_ws, data) {
        try {
          events.push(JSON.parse(String(data)));
        } catch {}
      },
    },
  });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      gateway_url: `http://127.0.0.1:${server.port}`,
      daemon_token: "skills-daemon-token",
      api_key: "skills-daemon-key",
      host_id: "skills-host",
      name: "Skills",
      auto_update: false,
      settings: { no_auto_title: true, reasoning: "none", auto_compact_threshold: 0 },
    }),
  );
  const proc = Bun.spawn([binary, "--slot", "a", "--data-dir", dir], {
    env: { ...process.env, ICD_WAIT_TOOL: "200ms", ICD_WATCH_EVERY: "5s", ICD_AUTOBG_AFTER: "1s" },
    stdout: Bun.file(join(dir, "stdout.log")),
    stderr: Bun.file(join(dir, "stderr.log")),
  });
  const wait = async (pred: () => any, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = pred();
      if (v) return v;
      await Bun.sleep(20);
    }
    return null;
  };
  const send = (m: any) => socket.send(JSON.stringify({ ...m, hostId: "skills-host" }));
  let pullSeq = 0;
  const pullConfig = async () => {
    const id = `cfg-${++pullSeq}`;
    send({ type: "pull", id, collection: "config" });
    const ev = await wait(() => events.find((e) => e.type === "pull-response" && e.id === id));
    if (!ev) throw new Error("config pull timeout");
    assert.equal(ev.error, undefined, `config pull error: ${ev.error}`);
    return ev.items[0];
  };
  const waitConfigChange = async (from: number, what: string) => {
    const ev = await wait(() => events.slice(from).find((e) => e.type === "change" && e.collection === "config"), 12000);
    assert.ok(ev, `${what}: skill directory change did not emit a config change ping`);
  };
  /** Polls the config mirror until pred holds: the reload itself is what
   * matters; the debounced ping only tells clients to re-pull. */
  const pollConfig = async (pred: (doc: any) => boolean, ms = 10000) => {
    const deadline = Date.now() + ms;
    let last: any = null;
    while (Date.now() < deadline) {
      last = await pullConfig();
      if (pred(last)) return last;
      await Bun.sleep(200);
    }
    return last;
  };
  const create = async (requestId: string, mode: string, skillsChoice?: string[]) => {
    send({
      type: "create_session",
      requestId,
      cwd: work,
      title: "skills",
      model: "m",
      options: { mode, access: "full", effort: "none", ...(skillsChoice ? { skills: skillsChoice.map((name) => ({ name })) } : {}) },
    });
    const ev = await wait(() => events.find((e) => e.type === "session_created" && e.requestId === requestId));
    if (!ev) throw new Error("create timeout");
    return ev.session.id as string;
  };
  try {
    if (!(await wait(() => socket, 12000))) throw new Error("daemon did not connect: " + readFileSync(join(dir, "stderr.log"), "utf8"));

    // --- 1. Config pull: builtin generative_ui_agentic + skillErrors array ---
    const cfg0 = await pullConfig();
    const genUI = cfg0.skills?.generative_ui_agentic;
    assert.ok(genUI, "config pull must list generative_ui_agentic");
    assert.equal(genUI.usable, "deny", `generative_ui_agentic must be usable deny, got ${genUI.usable}`);
    assert.equal(genUI.mode, "agentic", `generative_ui_agentic must be mode agentic, got ${genUI.mode}`);
    assert(Array.isArray(cfg0.skillErrors), `skillErrors must be an array, got ${JSON.stringify(cfg0.skillErrors)}`);

    // --- 2. A new skill file hot-reloads + pings config ---
    // Let the boot-time config notifications settle so the next change event
    // can only come from the skill watcher.
    await Bun.sleep(1000);
    let from = events.length;
    writeFileSync(join(skills, "hot.js"), `export default { name: "hot", description: "d", usable: "ask", body: "x" };`);
    await waitConfigChange(from, "hot add");
    const cfgHot = await pollConfig((doc) => !!doc.skills?.hot);
    assert.ok(cfgHot.skills?.hot, `new skill file must appear in the config listing without a restart (errors: ${JSON.stringify(cfgHot.skillErrors)})`);
    assert.equal(cfgHot.skills.hot.usable, "ask");

    // --- 3. A broken file pings, reports a skillError, and hides the temp dir ---
    from = events.length;
    writeFileSync(join(skills, "broken.js"), `export default {`);
    await waitConfigChange(from, "broken file");
    const cfgBroken = await pollConfig((doc) => doc.skillErrors?.some((e: string) => e.includes("broken.js")));
    assert(Array.isArray(cfgBroken.skillErrors) && cfgBroken.skillErrors.length === 1, `one broken file must produce one skillError, got ${JSON.stringify(cfgBroken.skillErrors)}`);
    assert(cfgBroken.skillErrors[0].includes("broken.js"), `skillError must name the file, got ${JSON.stringify(cfgBroken.skillErrors)}`);
    assert(!cfgBroken.skillErrors[0].includes(dir), `skillError must not leak the absolute data dir, got ${JSON.stringify(cfgBroken.skillErrors)}`);
    assert.ok(cfgBroken.skills?.hot, "a broken sibling must not remove the good skill");

    // --- 4. Deleting the file removes the skill after the ping ---
    from = events.length;
    unlinkSync(join(skills, "hot.js"));
    await waitConfigChange(from, "hot delete");
    const cfgGone = await pollConfig((doc) => !doc.skills?.hot);
    assert.equal(cfgGone.skills?.hot, undefined, `deleted skill must disappear, got ${JSON.stringify(cfgGone.skills?.hot)}`);

    // --- 5. /Compact (capitalized) is handled by the daemon, never by a model turn ---
    const compactSID = await create("compact", "talk");
    const beforeRequests = requests.length;
    from = events.length;
    send({ type: "prompt", sessionId: compactSID, text: "/Compact", requestId: "compact-send" });
    await Bun.sleep(1500);
    assert.equal(requests.length, beforeRequests, `capitalized /Compact must not reach the provider, got ${JSON.stringify(requests.slice(beforeRequests))}`);
    assert(
      !events.slice(from).some((e) => e.type === "session_status" && e.sessionId === compactSID && e.status === "running"),
      "capitalized /Compact started a model turn",
    );

    // --- 6. Remembered selection keeps the skill choice. The contract names
    // create_session and configure_session; probe both. ---
    const sid = await create("skills-create", "agentic", ["build"]);
    const cfgCreate = await pullConfig();
    const createSkills = cfgCreate.lastSelection?.skills;
    const createKeeps = Array.isArray(createSkills) && createSkills.some((s: any) => s?.name === "build");
    // Unknown and base-only (usable never) names must drop from the
    // remembered choice.
    send({ type: "configure_session", sessionId: sid, model: "m", options: { mode: "agentic", access: "full", effort: "none", skills: [{ name: "build" }, { name: "nope" }, { name: "agentic_base" }] } });
    // rememberSelection is a host-lane write; the pull is ordered after it.
    const cfgConfigure = await pullConfig();
    const configureSkills = cfgConfigure.lastSelection?.skills;
    const configureKeeps = Array.isArray(configureSkills) && configureSkills.length === 1 && configureSkills[0]?.name === "build";

    const result = {
      generativeUI: `${genUI.usable}/${genUI.mode}`,
      skillErrorsIsArray: Array.isArray(cfg0.skillErrors),
      hotAdded: !!cfgHot.skills?.hot,
      brokenReportedRelatively: cfgBroken.skillErrors[0],
      hotRemoved: cfgGone.skills?.hot === undefined,
      compactProviderRequests: requests.length - beforeRequests,
      // lastSelection as observed, so a failure names the exact payload.
      createLastSelection: cfgCreate.lastSelection,
      configureLastSelection: cfgConfigure.lastSelection,
      rememberAfterCreate: createKeeps,
      rememberAfterConfigure: configureKeeps,
    };
    console.log(JSON.stringify(result, null, 2));
    assert(configureKeeps, `configure_session must remember its skills, got ${JSON.stringify(cfgConfigure.lastSelection)}`);
    assert(
      createKeeps,
      `create_session must remember its skills, got ${JSON.stringify(cfgCreate.lastSelection)}: the create_session handler calls admin.createSession only; rememberSelection runs on the configure_session paths`,
    );
    console.log("PASS skills-daemon: builtin listing, hot add/remove, relative skillErrors, remembered skills, case-insensitive /Compact");
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          events: events.slice(-80).map((e) => ({ type: e.type, collection: e.collection, id: e.id, sessionId: e.sessionId || e.session?.id, status: e.status, requestId: e.requestId, error: e.message })),
          requests: requests.slice(-5),
          stdout: readFileSync(join(dir, "stdout.log"), "utf8"),
          stderr: readFileSync(join(dir, "stderr.log"), "utf8"),
          skillsDir: skills,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    server.stop(true);
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (e) {
        if (i === 2) console.warn("[fixture] temp cleanup failed (handles still open):", String(e).slice(0, 200));
        else await Bun.sleep(2000);
      }
    }
  }
}

await run();
