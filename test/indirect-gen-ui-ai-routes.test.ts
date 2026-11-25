import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { db, type UserRow } from "../server/db";
import { insertSessionRow, prepareSessionTokens } from "../server/auth";
import { encryptSecret, randomToken, sha256Hex } from "../server/crypto";
import { GATEWAY_SECRET } from "../server/config";
import { ApiError } from "../server/http";
import { insertPreparedKey, prepareKey } from "../server/keys";
import { invalidateModelCache } from "../server/models";
import { handleGenUiRoute } from "../server/routes/gen-ui";
import { resetGenUiAiLimiter } from "../server/routes/gen-ui-ai";

const BASE = "http://gw.test";

let upstreamServer: ReturnType<typeof Bun.serve>;
let upstreamBaseUrl = "";
let lastUpstreamBody: Record<string, unknown> | null = null;
let upstreamMode: "ok" | "stream" | "stream_error" | "slow_stream" | "upstream_401" | "ok_200_error" = "ok";

let userId = "";
let otherUserId = "";
let noKeyUserId = "";
let authToken = "";
let otherAuthToken = "";
let noKeyAuthToken = "";
let hostId = "";
let hostKeyId = "";
let providerId = "";
let providerKeyId = "";
const modelReasoning = `genui-ai-test-deepseek-reasoner-${Date.now()}`;
const modelPlain = `genui-ai-test-gpt-4o-mini-${Date.now()}`;

async function callRoute(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; token?: string | null; signal?: AbortSignal } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const tok = opts.token === undefined ? authToken : opts.token;
  if (tok) headers.authorization = `Bearer ${tok}`;
  const url = new URL(BASE + path);
  const res = await handleGenUiRoute(
    url.pathname,
    new Request(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    }),
    url,
  );
  if (!res) throw new Error(`route not handled: ${method} ${path}`);
  return res;
}

describe("gen-ui embedded AI routes (/api/indirect-code/gen-ui/ai/*)", () => {
  beforeAll(async () => {
    upstreamServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== "/v1/chat/completions" || req.method !== "POST") {
          return new Response(JSON.stringify({ error: { message: "not found" } }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        lastUpstreamBody = (await req.json()) as Record<string, unknown>;
        const wantStream = lastUpstreamBody.stream === true;

        if (upstreamMode === "upstream_401") {
          return new Response(JSON.stringify({ error: { message: "bad upstream provider key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (upstreamMode === "ok_200_error") {
          return new Response(JSON.stringify({ error: { message: "provider soft error" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (wantStream && upstreamMode === "slow_stream") {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    id: "cmpl_slow",
                    model: lastUpstreamBody?.model,
                    choices: [{ index: 0, delta: { content: "Part 1 " }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              await Bun.sleep(4000);
              try {
                controller.enqueue(enc.encode("data: [DONE]\n\n"));
                controller.close();
              } catch {}
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          });
        }

        if (wantStream && upstreamMode === "stream_error") {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    id: "cmpl_err",
                    model: lastUpstreamBody?.model,
                    choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify({ error: { message: "upstream boom" } })}\n\n`),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          });
        }

        if (wantStream) {
          const enc = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    id: "cmpl_s1",
                    model: lastUpstreamBody?.model,
                    choices: [{ index: 0, delta: { reasoning_content: "Think..." }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    id: "cmpl_s1",
                    model: lastUpstreamBody?.model,
                    choices: [{ index: 0, delta: { content: "Hello " }, finish_reason: null }],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                enc.encode(
                  `data: ${JSON.stringify({
                    id: "cmpl_s1",
                    model: lastUpstreamBody?.model,
                    choices: [{ index: 0, delta: { content: "chess!" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 25, completion_tokens: 10 },
                  })}\n\n`,
                ),
              );
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: { "content-type": "text/event-stream; charset=utf-8" },
          });
        }

        const messages = Array.isArray(lastUpstreamBody.messages) ? lastUpstreamBody.messages : [];
        const sys = messages.find((m: any) => m.role === "system")?.content ?? "";
        const replyText =
          typeof sys === "string" && sys.includes("valid JSON")
            ? '{"move":"e7e5","taunt":"Your turn"}'
            : `Echo: ${messages.at(-1)?.content ?? ""}`;

        return new Response(
          JSON.stringify({
            id: "cmpl_1",
            object: "chat.completion",
            model: lastUpstreamBody.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: replyText,
                  reasoning_content: "Evaluated center control.",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 40,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 10 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.port}/v1`;

    const now = Date.now();
    providerId = `prov_genui_ai_${randomToken(6)}`;
    providerKeyId = `pk_genui_ai_${randomToken(6)}`;
    const encKey = await encryptSecret("sk-fake-upstream-key", GATEWAY_SECRET);

    db.prepare(
      `INSERT INTO providers (id, name, openai_base_url, openai_auth_style, api_key_enc, enabled, priority, created_at)
       VALUES (?, ?, ?, 'bearer', ?, 1, 1, ?)`,
    ).run(providerId, "GenUI Fake Provider", upstreamBaseUrl, encKey, now);
    db.prepare(
      `INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
       VALUES (?, ?, 'primary', ?, 1, 'active', ?, ?)`,
    ).run(providerKeyId, providerId, encKey, now, now);

    for (const [id, upstream] of [
      [modelReasoning, "deepseek-reasoner"],
      [modelPlain, "gpt-4o-mini"],
    ] as const) {
      db.prepare(
        `INSERT INTO models (id, name, provider_id, upstream_model, context_length, max_output_length, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 128000, 8192, 1, ?, ?)`,
      ).run(id, id, providerId, upstream, now, now);
      db.prepare(
        `INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at)
         VALUES (?, ?, ?, 1, 1, ?)`,
      ).run(id, providerId, upstream, now);
    }
    invalidateModelCache();

    const makeUser = async (tag: string) => {
      const id = `u_guai_${tag}_${randomToken(6)}`;
      db.prepare(
        "INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', ?)",
      ).run(id, `${id}@test.local`, `User ${tag}`, now);
      const row = db.prepare<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id)!;
      const tokens = await prepareSessionTokens(row);
      insertSessionRow(row.id, tokens);
      return { id, token: tokens.accessToken };
    };

    const mainU = await makeUser("main");
    userId = mainU.id;
    authToken = mainU.token;

    const otherU = await makeUser("other");
    otherUserId = otherU.id;
    otherAuthToken = otherU.token;

    const noKeyU = await makeUser("nokey");
    noKeyUserId = noKeyU.id;
    noKeyAuthToken = noKeyU.token;

    // Pair one Indirect Code host with a dedicated API key for main user.
    const prepKey = await prepareKey(userId, { name: "Daemon: GenUI Test" });
    const keyRow = insertPreparedKey(prepKey, now);
    hostKeyId = keyRow.id;
    hostId = `host_guai_${randomToken(6)}`;
    db.prepare(
      `INSERT INTO remote_hosts (id, user_id, name, hostname, os, arch, daemon_token_hash, api_key_id, status, last_seen_at, created_at)
       VALUES (?, ?, 'Test Host', 'test-pc', 'linux', 'amd64', ?, ?, 'online', ?, ?)`,
    ).run(hostId, userId, sha256Hex(`dmt_${randomToken(12)}`), hostKeyId, now, now);
  });

  beforeEach(() => {
    resetGenUiAiLimiter();
    lastUpstreamBody = null;
    upstreamMode = "ok";
  });

  afterAll(() => {
    try {
      upstreamServer?.stop(true);
    } catch {}
    for (const id of [modelReasoning, modelPlain]) {
      db.prepare("DELETE FROM model_targets WHERE model_id = ?").run(id);
      db.prepare("DELETE FROM models WHERE id = ?").run(id);
    }
    db.prepare("DELETE FROM provider_keys WHERE id = ?").run(providerKeyId);
    db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
    for (const uid of [userId, otherUserId, noKeyUserId]) {
      if (!uid) continue;
      db.prepare("DELETE FROM remote_hosts WHERE user_id = ?").run(uid);
      db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(uid);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(uid);
      db.prepare("DELETE FROM users WHERE id = ?").run(uid);
    }
    invalidateModelCache();
  });

  test("rejects unauthenticated requests to /ai/models and /ai/complete with 401", async () => {
    for (const [m, p, b] of [
      ["GET", "/api/indirect-code/gen-ui/ai/models", undefined],
      ["POST", "/api/indirect-code/gen-ui/ai/complete", { model: modelReasoning, prompt: "hi" }],
    ] as const) {
      let caught: unknown;
      try {
        await callRoute(m, p, { body: b, token: null });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(401);
    }
  });

  test("GET /ai/models lists allowed models and effort tiers and isolates hostId ownership", async () => {
    const res = await callRoute("GET", `/api/indirect-code/gen-ui/ai/models?hostId=${encodeURIComponent(hostId)}`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.models.some((m: any) => m.id === modelReasoning)).toBe(true);
    expect(data.efforts.map((e: any) => e.id)).toEqual([
      "none",
      "minimum",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    // Another user cannot query this user's hostId.
    const foreign = await callRoute("GET", `/api/indirect-code/gen-ui/ai/models?hostId=${encodeURIComponent(hostId)}`, {
      token: otherAuthToken,
    });
    expect(foreign.status).toBe(404);
  });

  test("POST /ai/complete runs buffered completion, forwards effort, strips tools, and supports JSON mode", async () => {
    const res = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: {
        hostId,
        model: modelReasoning,
        effort: "high",
        system: "You are a chess opponent.",
        prompt: "White plays e2e4.",
        maxTokens: 256,
        temperature: 0.3,
        json: true,
        // Must NEVER be forwarded upstream (text-only contract):
        tools: [{ type: "function", function: { name: "bash", parameters: {} } }],
        tool_choice: "required",
      },
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.success).toBe(true);
    expect(body.text).toBe('{"move":"e7e5","taunt":"Your turn"}');
    expect(body.reasoning).toBe("Evaluated center control.");
    expect(body.effort).toBe("high");
    expect(body.finishReason).toBe("stop");
    expect(body.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.outputTokens).toBe(12);

    expect(lastUpstreamBody).not.toBeNull();
    expect(lastUpstreamBody!.reasoning_effort).toBe("high");
    expect(lastUpstreamBody!.tools).toBeUndefined();
    expect(lastUpstreamBody!.tool_choice).toBeUndefined();
    expect(lastUpstreamBody!.max_tokens).toBe(256);
    expect(lastUpstreamBody!.temperature).toBe(0.3);
  });

  test("POST /ai/complete normalizes effort aliases and drops reasoning_effort for effort=off or non-reasoning models", async () => {
    const offRes = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, effort: "off", prompt: "Ping" },
    });
    expect(offRes.status).toBe(200);
    const offData: any = await offRes.json();
    expect(offData.effort).toBe("none");
    expect(lastUpstreamBody!.reasoning_effort).toBeUndefined();

    const minRes = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, effort: "minimal", prompt: "Ping" },
    });
    expect(minRes.status).toBe(200);
    expect(((await minRes.json()) as any).effort).toBe("minimum");
    expect(lastUpstreamBody!.reasoning_effort).toBe("minimum");

    // Non-reasoning model (gpt-4o-mini) strips reasoning_effort automatically via target-profile.
    const plainRes = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelPlain, effort: "max", prompt: "Ping" },
    });
    expect(plainRes.status).toBe(200);
    expect(lastUpstreamBody!.reasoning_effort).toBeUndefined();
  });

  test("POST /ai/complete streams normalized delta, reasoning, and done SSE frames", async () => {
    const res = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: {
        hostId,
        model: modelReasoning,
        effort: "medium",
        messages: [{ role: "user", content: "Play chess" }],
        stream: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const raw = await res.text();
    const events = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));

    expect(events.some((e) => e.type === "reasoning" && e.text === "Think...")).toBe(true);
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    expect(deltas).toBe("Hello chess!");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done.text).toBe("Hello chess!");
    expect(done.reasoning).toBe("Think...");
    expect(done.finishReason).toBe("stop");
    expect(done.usage.outputTokens).toBe(10);
  });

  test("POST /ai/complete surfaces mid-stream upstream errors as SSE error frames", async () => {
    upstreamMode = "stream_error";
    const res = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, prompt: "Fail mid stream", stream: true },
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const events = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5).trim()));
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("POST /ai/complete validates bad payloads, foreign hostId, and missing user API key", async () => {
    const badEffort = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, effort: "ultra-hyper", prompt: "hi" },
    });
    expect(badEffort.status).toBe(400);

    const emptyMsg = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, system: "Only system" },
    });
    expect(emptyMsg.status).toBe(400);

    const foreignHost = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, prompt: "hi" },
      token: otherAuthToken,
    });
    expect(foreignHost.status).toBe(404);

    const noKey = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { model: modelReasoning, prompt: "hi" },
      token: noKeyAuthToken,
    });
    expect(noKey.status).toBe(403);
  });

  test("POST /ai/complete enforces revoked host key rather than silently bypassing it", async () => {
    db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").run(hostKeyId);
    try {
      const res = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
        body: { hostId, model: modelReasoning, prompt: "Should fail" },
      });
      expect(res.status).toBe(429);
      const data: any = await res.json();
      expect(data.error).toContain("revoked");
    } finally {
      db.prepare("UPDATE api_keys SET status = 'active' WHERE id = ?").run(hostKeyId);
    }
  });

  test("POST /ai/complete remaps upstream 401 to 502 (never triggers dashboard JWT logout) and catches 200-wrapped JSON errors", async () => {
    upstreamMode = "upstream_401";
    const r401 = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, prompt: "Trigger upstream 401" },
    });
    expect(r401.status).toBe(502);
    expect(((await r401.json()) as any).error).toContain("bad upstream provider key");

    upstreamMode = "ok_200_error";
    const r200Err = await callRoute("POST", "/api/indirect-code/gen-ui/ai/complete", {
      body: { hostId, model: modelReasoning, prompt: "Trigger 200 error" },
    });
    expect(r200Err.status).toBe(502);
    expect(((await r200Err.json()) as any).error).toContain("provider soft error");
  });
});
