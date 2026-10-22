import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/**
 * Upstream-failure regression suite: the real `handleProxy` with `fetch`
 * stubbed. No sockets, no ports, no fake-upstream process.
 *
 * What it pins down (AGENTS.md "Gateway constraints"):
 *  - failover classification: billing/auth/rate-limit/transient/model-not-found
 *    advance this request, plain 4xx do not;
 *  - the client gets the REAL last upstream error (status + body + Retry-After),
 *    never a generic 503;
 *  - upstream response headers are sanitized on error paths too (no
 *    set-cookie, no upstream CSP/XFO, content-type clamped to the safe set);
 *  - network failures -> 502, our header timeout -> 504, truncated bodies ->
 *    502, always in the client's protocol envelope;
 *  - a mid-stream upstream reset emits one SSE error event and never fails
 *    over (bytes already reached the client);
 *  - the per provider+capability circuit breaker only trips on infrastructure
 *    failures and 503s only when nothing is reachable.
 *
 * Hermeticity: every scenario gets its OWN model + providers (unique ids per
 * run), so the in-memory sticky-winner lane and the circuit breaker of one
 * test can never leak into the next. afterAll removes every row and restores
 * the routing mode.
 */

process.env.GATEWAY_SECRET = "test-secret-that-is-long-enough-32+";
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gw-pe-"));

const { db } = await import("../server/db");
const { encryptSecret, sha256Hex, randomToken } = await import("../server/crypto");
const { GATEWAY_SECRET, LIMITS } = await import("../server/config");
const { handleProxy } = await import("../server/proxy/index");
const { flushUsage } = await import("../server/usage");
const { invalidateModelCache } = await import("../server/models");
const { stickyClearAll } = await import("../server/failover");

const RUN = randomToken(6);
const UID = `u-pe-${RUN}`;
const KEYID = `key-pe-${RUN}`;
const GW_KEY = `gw_${RUN}${"b".repeat(48 - RUN.length)}`;
const UP_KEY = "sk-upstream-pe";
const now = Date.now();

const enc = await encryptSecret(UP_KEY, GATEWAY_SECRET);

// ---------------------------------------------------------------- fetch stub

interface Call {
  url: string;
  host: string;
  auth: string | null;
}

const realFetch = globalThis.fetch;
const calls: Call[] = [];
/** Per-upstream-host behaviour. A host without an entry is a test bug. */
const handlers = new Map<string, (init: RequestInit) => Response | Promise<Response>>();

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url = String(input);
  const host = new URL(url).hostname;
  calls.push({ url, host, auth: new Headers(init.headers).get("authorization") });
  const handler = handlers.get(host);
  if (!handler) throw new Error(`unexpected upstream call: ${host}`);
  return await handler(init as RequestInit);
}) as typeof fetch;

const enc8 = new TextEncoder();
const CHAT_OK = {
  id: "chatcmpl-pe",
  object: "chat.completion",
  created: 0,
  model: "fake-llm-1",
  choices: [{ index: 0, message: { role: "assistant", content: "upstream ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
};

const okJson = () => () => Response.json(CHAT_OK);
const errJson = (status: number, message: string, headers: Record<string, string> = {}) => () =>
  Response.json({ error: { message, type: "upstream_error", code: null } }, { status, headers });
const errRaw = (status: number, body: string, contentType: string, headers: Record<string, string> = {}) => () =>
  new Response(body, { status, headers: { "content-type": contentType, ...headers } });

/** Accepts the connection, then never answers (drives our header timeout). */
const hang = () => (init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal!;
    const bail = () => reject(Object.assign(new Error("upstream header timeout"), { name: "AbortError" }));
    if (signal.aborted) return bail();
    signal.addEventListener("abort", bail, { once: true });
  });

/** Connection-level failure (DNS, ECONNREFUSED, TLS). */
const netErr = (message = "ECONNREFUSED") => () => {
  throw new TypeError(`fetch failed: ${message}`);
};

/** 200 that dies halfway: simulates an upstream truncating a buffered body. */
const brokenBody = () => () =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc8.encode('{"id":"chatcmpl-pe","choices":['));
        c.error(new Error("socket hang up"));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** SSE that emits `frames`, then resets the connection (no terminal event). */
const sseThenReset = (frames: string[]) => () => {
  let i = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < frames.length) {
          c.enqueue(enc8.encode(`data: ${frames[i++]}\n\n`));
          return;
        }
        c.error(new Error("upstream reset"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

// ------------------------------------------------------------------- seeding

interface Lane {
  model: string;
  /** upstream hostname per target, in failover order */
  hosts: Record<string, string>;
  /** provider ids, in failover order */
  providers: Record<string, string>;
}

/** One model with its own provider(s): a private routing lane. */
function seedLane(name: string, targets: Array<"a" | "b"> = ["a", "b"]): Lane {
  const model = `alias-pe-${RUN}-${name}`;
  const hosts: Record<string, string> = {};
  const providers: Record<string, string> = {};
  db.transaction(() => {
    db.prepare(
      "INSERT INTO models (id, provider_id, upstream_model, enabled, created_at, updated_at) VALUES (?, NULL, 'fake-llm-1', 1, ?, ?)",
    ).run(model, now, now);
    targets.forEach((t, i) => {
      const pid = `p-pe-${RUN}-${name}-${t}`;
      const host = `${pid}.up.test`;
      hosts[t] = host;
      providers[t] = pid;
      db.prepare(
        "INSERT INTO providers (id, name, openai_base_url, api_key_enc, enabled, priority, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      ).run(pid, `pe-${t}`, `http://${host}/openai/v1`, enc, 10 + i, now);
      db.prepare(
        "INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at) VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)",
      ).run(`k-pe-${RUN}-${name}-${t}`, pid, enc, now, now);
      db.prepare(
        "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, 'fake-llm-1', ?, 1, ?)",
      ).run(model, pid, i, now);
    });
    db.prepare("UPDATE models SET provider_id = ? WHERE id = ?").run(providers.a!, model);
  })();
  invalidateModelCache();
  return { model, hosts, providers };
}

function route(lane: Lane, t: "a" | "b", handler: (init: RequestInit) => Response | Promise<Response>) {
  handlers.set(lane.hosts[t]!, handler);
}

function openaiChat(body: Record<string, unknown>) {
  const url = new URL("http://gw/v1/chat/completions");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GW_KEY}` },
      body: JSON.stringify(body),
    }),
    url,
  };
}

function anthropicMessages(body: Record<string, unknown>) {
  const url = new URL("http://gw/v1/messages");
  return {
    req: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": GW_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    }),
    url,
  };
}

async function chat(model: string, extra: Record<string, unknown> = {}): Promise<Response> {
  const { req, url } = openaiChat({ model, messages: [{ role: "user", content: "hi" }], ...extra });
  return await handleProxy(req, url, undefined);
}

beforeAll(() => {
  db.prepare("INSERT INTO users (id, email, status, created_at) VALUES (?, 'pe@x.com', 'active', ?)").run(UID, now);
  db.prepare(
    "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 'pe', ?, ?, 'active', ?)",
  ).run(KEYID, UID, GW_KEY.slice(0, 8), sha256Hex(GW_KEY), now);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('routing_mode', 'router') ON CONFLICT(key) DO UPDATE SET value='router'",
  ).run();
  invalidateModelCache();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  flushUsage();
  db.transaction(() => {
    db.prepare("DELETE FROM usage_events WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM usage_daily WHERE key_id = ?").run(KEYID);
    db.prepare("DELETE FROM models WHERE id LIKE ?").run(`alias-pe-${RUN}%`);
    db.prepare("DELETE FROM providers WHERE id LIKE ?").run(`p-pe-${RUN}%`);
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(KEYID);
    db.prepare("DELETE FROM users WHERE id = ?").run(UID);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('routing_mode', 'passthrough') ON CONFLICT(key) DO UPDATE SET value='passthrough'",
    ).run();
  })();
  invalidateModelCache();
});

beforeEach(() => {
  handlers.clear();
  calls.length = 0;
  stickyClearAll();
});

// ------------------------------------------------------------------- failover

describe("upstream failover classification", () => {
  test("5xx advances to the next target and reports attempts", async () => {
    const lane = seedLane("t500");
    route(lane, "a", errJson(503, "upstream overloaded"));
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("upstream ok");
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    expect(calls.map((c) => c.host)).toEqual([lane.hosts.a, lane.hosts.b]);
  });

  test("402 (billing) advances to the next target", async () => {
    const lane = seedLane("t402");
    route(lane, "a", errJson(402, "Insufficient credits on this account"));
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
  });

  test("401 (auth) advances to the next target", async () => {
    const lane = seedLane("t401");
    route(lane, "a", errJson(401, "invalid api key"));
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
  });

  test("404 model_not_found advances to the next target", async () => {
    const lane = seedLane("t404");
    route(lane, "a", errJson(404, "model 'fake-llm-1' not found on this provider"));
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
  });

  test("400 (client error) does NOT fail over and stays byte-faithful", async () => {
    const lane = seedLane("t400");
    const upstreamBody = JSON.stringify({
      error: { message: "messages: field required", type: "invalid_request_error", param: "messages" },
      upstream_trace: "abc123",
    });
    route(lane, "a", errRaw(400, upstreamBody, "application/json"));
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(400);
    // Exactly one upstream attempt: every other candidate would reject it too.
    expect(calls.map((c) => c.host)).toEqual([lane.hosts.a]);
    expect(res.headers.get("x-gateway-attempts")).toBe("1");
    // Same-protocol JSON error bodies pass through byte-for-byte (design).
    expect(await res.text()).toBe(upstreamBody);
  });

  test("429 keeps the real status, body and Retry-After", async () => {
    const lane = seedLane("t429");
    route(lane, "a", errJson(429, "rate limited, retry in 3s", { "retry-after": "3" }));
    route(lane, "b", errJson(429, "rate limit exceeded for this key", { "retry-after": "37" }));

    const res = await chat(lane.model);
    expect(res.status).toBe(429);
    // The client owns backoff: the LAST upstream hint must reach it verbatim.
    expect(res.headers.get("retry-after")).toBe("37");
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
    const j = await res.json();
    expect(JSON.stringify(j)).toContain("rate limit exceeded");
  });

  test("when every candidate fails the last real upstream error wins", async () => {
    const lane = seedLane("tlast");
    route(lane, "a", errJson(402, "Payment required: account is out of credits"));
    route(lane, "b", errJson(402, "insufficient_quota: you exceeded your current quota"));

    const res = await chat(lane.model);
    expect(res.status).toBe(402); // not a generic 503
    const j = await res.json();
    expect(JSON.stringify(j)).toContain("insufficient_quota");
    expect(calls.length).toBe(2);
  });
});

// -------------------------------------------------------------------- headers

describe("error response hygiene", () => {
  test("upstream security headers and cookies never reach the client", async () => {
    const lane = seedLane("hdr", ["a"]);
    route(
      lane,
      "a",
      errRaw(500, "<html><body>kaput</body></html>", "text/html", {
        "set-cookie": "session=stolen; Path=/",
        "content-security-policy": "default-src * 'unsafe-inline'",
        "x-frame-options": "ALLOWALL",
        "x-content-type-options": "off",
        "referrer-policy": "unsafe-url",
        "www-authenticate": 'Basic realm="upstream"',
        "retry-after": "11",
      }),
    );

    const res = await chat(lane.model);
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    // The gateway's own policy wins, so an upstream can never serve a live
    // document on our origin.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // Hostile content type is clamped; harmless upstream headers survive.
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("retry-after")).toBe("11");
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="upstream"');
  });

  test("a non-JSON upstream error body is wrapped in the protocol envelope", async () => {
    const lane = seedLane("html", ["a"]);
    route(lane, "a", errRaw(500, "<html><body>kaput</body></html>", "text/html"));

    const res = await chat(lane.model);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // A client parsing JSON must not choke on an upstream HTML page: the
    // text is preserved as the envelope message, not sprayed raw at an
    // SDK that was promised application/json.
    const j = await res.json();
    expect(j.error.type).toBe("api_error");
    expect(j.error.message).toContain("kaput");
  });

  test("a text/plain upstream error body is wrapped too", async () => {
    const lane = seedLane("plain", ["a"]);
    route(lane, "a", errRaw(502, "upstream connect error or disconnect/reset", "text/plain"));

    const res = await chat(lane.model);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.message).toContain("upstream connect error");
  });
});

// ------------------------------------------------------- network / transport

describe("transport failures", () => {
  test("a network error becomes a 502 api_error envelope", async () => {
    const lane = seedLane("net", ["a"]);
    route(lane, "a", netErr("ECONNREFUSED 10.0.0.7:443"));

    const res = await chat(lane.model);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.type).toBe("api_error");
    expect(j.error.message).toBe("upstream is unreachable");
  });

  test("a network error fails over to a healthy target", async () => {
    const lane = seedLane("netfo");
    route(lane, "a", netErr());
    route(lane, "b", okJson());

    const res = await chat(lane.model);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-gateway-attempts")).toBe("2");
  });

  test("our header timeout becomes a 504 api_error envelope", async () => {
    const lane = seedLane("slow", ["a"]);
    route(lane, "a", hang());
    const prev = LIMITS.upstreamNonStreamTimeoutMs;
    LIMITS.upstreamNonStreamTimeoutMs = 120; // keep the test fast
    try {
      const res = await chat(lane.model);
      expect(res.status).toBe(504);
      const j = await res.json();
      expect(j.error.type).toBe("api_error");
      expect(j.error.message).toBe("upstream took too long to respond");
    } finally {
      LIMITS.upstreamNonStreamTimeoutMs = prev;
    }
  });

  test("a truncated buffered upstream body becomes a 502 envelope", async () => {
    const lane = seedLane("trunc", ["a"]);
    route(lane, "a", brokenBody());

    const res = await chat(lane.model);
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.error.type).toBe("api_error");
    expect(j.error.message).toBe("upstream response failed");
  });

  test("a mid-stream reset emits an SSE error event and never fails over", async () => {
    const lane = seedLane("reset");
    route(
      lane,
      "a",
      sseThenReset([
        JSON.stringify({ id: "chatcmpl-pe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "par" }, finish_reason: null }] }),
        JSON.stringify({ id: "chatcmpl-pe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "tial" }, finish_reason: null }] }),
      ]),
    );
    route(lane, "b", okJson());

    const res = await chat(lane.model, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    // The bytes that did arrive are delivered (the translator may split one
    // streamed word across frames, so assert on the deltas, not the word).
    expect(body).toContain('"content":"par"');
    expect(body).toContain('"content":"tial"');
    expect(body).toContain("Upstream stream interrupted");
    // An interrupted stream must not look like a clean finish.
    expect(body).not.toContain("[DONE]");
    // Headers were already flushed: no second candidate may be attempted.
    expect(calls.map((c) => c.host)).toEqual([lane.hosts.a]);
  });
});

// ---------------------------------------------------------------- protocol

describe("error protocol mapping", () => {
  test("an Anthropic client gets an Anthropic envelope for an OpenAI-upstream failure", async () => {
    const lane = seedLane("anth", ["a"]);
    route(lane, "a", errJson(500, "upstream boom"));

    const { req, url } = anthropicMessages({
      model: lane.model,
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    });
    const res = await handleProxy(req, url, undefined);
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("api_error");
    expect(j.error.message).toBe("upstream boom");
  });
});

// --------------------------------------------------------- circuit breaker

describe("circuit breaker", () => {
  test("opens after repeated transient failures and 503s without an attempt", async () => {
    const lane = seedLane("cb", ["a"]);
    route(lane, "a", errJson(503, "upstream unavailable"));

    for (let i = 0; i < LIMITS.breakerFailThreshold; i++) {
      const res = await chat(lane.model);
      // Real upstream error is still delivered while the lane is closed.
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).toContain("upstream unavailable");
    }
    expect(calls.length).toBe(LIMITS.breakerFailThreshold);

    calls.length = 0;
    const open = await chat(lane.model);
    // Storm guard: nothing was reachable, so this is the ONLY 503 the client
    // sees that is not an upstream error.
    expect(open.status).toBe(503);
    expect(JSON.stringify(await open.json())).toContain("circuit-broken");
    expect(calls.length).toBe(0);
  });

  test("client errors (4xx) never trip the breaker", async () => {
    const lane = seedLane("cb4", ["a"]);
    route(lane, "a", errJson(400, "messages: field required"));

    for (let i = 0; i < LIMITS.breakerFailThreshold + 2; i++) {
      const res = await chat(lane.model);
      expect(res.status).toBe(400);
    }
    // Still reachable on the next request (a 4xx is the client's fault).
    const res = await chat(lane.model);
    expect(res.status).toBe(400);
  });
});
