import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

import { fetchOpenRouterCatalog, matchOpenRouterModel } from "../server/openrouter";
import { enrichParsedModel, type ParsedModel } from "../server/models";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

/**
 * OpenRouter upstream suite.
 *
 * The catalog transport tests run offline against a stubbed fetch, so `bun test`
 * stays hermetic on CI. Anything that reaches the real OpenRouter API is gated
 * on OPENROUTER_API_KEY (Bun loads the gitignored .env from the repo root) and
 * skips without it; OPENROUTER_BASE_URL selects the API root when a deployment
 * points the gateway at a mirror.
 */

const apiKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
const apiBaseUrl = (process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const live = apiKey.length > 0;
const LIVE_TIMEOUT_MS = 120_000;

const emptyParsedModel = (id: string): ParsedModel => ({
  id,
  name: id,
  description: "",
  context_length: null,
  max_output_length: null,
  input_modalities: ["text"],
  output_modalities: ["text"],
  sampling_params: [],
  features: [],
  reasoning_efforts: null,
  pricing: null,
});

/** Minimal OpenRouter `/models` payload exercising every enrichment branch. */
const RAW_MODELS = [
  {
    id: "vendor/test-model",
    name: "Test Model",
    description: "x".repeat(2_500),
    context_length: 32_000,
    architecture: { modality: "text+image->text" },
    pricing: {
      prompt: "0.0000006",
      completion: "0.000002",
      input_cache_reads: "0.0000001",
      input_cache_writes: "0.0000002",
    },
    top_provider: { max_completion_tokens: 8_192 },
    supported_parameters: ["temperature", "tools"],
    supported_features: ["tools"],
  },
  {
    id: "vendor/context-only",
    name: "Context Only",
    top_provider: { context_length: 16_000 },
  },
  { id: 42, name: "invalid row without an id" },
];

describe("OpenRouter catalog transport", () => {
  test("parses models and normalizes pricing and metadata", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({ data: RAW_MODELS })) as unknown as typeof fetch;
      const catalog = await fetchOpenRouterCatalog(true);
      expect(catalog).not.toBeNull();
      const rows = catalog!;
      // The row without a string id is skipped, never partially imported.
      expect(rows).toHaveLength(2);

      const model = rows[0]!;
      expect(model.id).toBe("vendor/test-model");
      expect(model.description).toHaveLength(2_000);
      expect(model.context_length).toBe(32_000);
      expect(model.max_output_length).toBe(8_192);
      expect(model.input_modalities).toEqual(["text", "image"]);
      expect(model.output_modalities).toEqual(["text"]);
      expect(model.sampling_params).toEqual(["temperature", "tools"]);
      expect(model.features).toEqual(["tools"]);
      // Upstream sends prices as decimal strings; the catalog stores numbers.
      expect(model.pricing).toEqual({
        prompt: 0.0000006,
        completion: 0.000002,
        input_cache_reads: 0.0000001,
        input_cache_writes: 0.0000002,
      });
      expect(model.pricing_input).toBe(0.0000006);
      expect(model.pricing_input_cache).toBe(0.0000001);
      expect(model.pricing_input_cache_write).toBe(0.0000002);
      expect(model.pricing_output).toBe(0.000002);

      const contextOnly = rows[1]!;
      expect(contextOnly.context_length).toBe(16_000);
      expect(contextOnly.pricing).toBeNull();
      expect(contextOnly.pricing_input).toBeNull();
      expect(contextOnly.input_modalities).toEqual(["text"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("keeps the last good catalog when the upstream fails", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({ data: RAW_MODELS })) as unknown as typeof fetch;
      const good = await fetchOpenRouterCatalog(true);
      const goodIds = good!.map((model) => model.id);

      const failures: Array<() => Response | never> = [
        () => new Response("upstream exploded", { status: 500 }),
        () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } }),
        () => new Response(JSON.stringify({ data: "not-an-array" }), { status: 200 }),
        () => {
          throw new Error("network down");
        },
      ];
      for (const failure of failures) {
        globalThis.fetch = (async () => failure()) as unknown as typeof fetch;
        const degraded = await fetchOpenRouterCatalog(true);
        // A failed refresh never throws and never empties enrichment data.
        expect(degraded?.map((model) => model.id)).toEqual(goodIds);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("returns null instead of throwing when nothing is cached and the endpoint is down", async () => {
    // A fresh module instance is the only way to observe the cold-start path:
    // this file already cached a catalog above, and the cache is per process.
    const script = `
      globalThis.fetch = async () => { throw new Error("offline"); };
      const { fetchOpenRouterCatalog } = await import(${JSON.stringify(path.join(import.meta.dir, "..", "server", "openrouter.ts"))});
      const catalog = await fetchOpenRouterCatalog(true);
      console.log(JSON.stringify({ catalog }));
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain("catalog fetch failed");
    const lastLine = stdout.trim().split("\n").pop() ?? "";
    expect(JSON.parse(lastLine)).toEqual({ catalog: null });
  }, 30_000);
});

describe.skipIf(!live)("OpenRouter catalog (live)", () => {
  test("serves the public model list without credentials", async () => {
    const response = await fetch(`${apiBaseUrl}/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data?: unknown };
    expect(Array.isArray(json.data)).toBe(true);
    expect((json.data as unknown[]).length).toBeGreaterThan(10);
  }, 30_000);

  test("fetches the live catalog with usable pricing and metadata", async () => {
    const catalog = await fetchOpenRouterCatalog(true);
    expect(catalog).not.toBeNull();
    const rows = catalog!;
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((model) => model.id.length > 0)).toBe(true);
    expect(rows.every((model) => (model.input_modalities ?? []).length > 0)).toBe(true);
    expect(rows.every((model) => (model.output_modalities ?? []).length > 0)).toBe(true);
    expect(rows.every((model) => (model.description ?? "").length <= 2_000)).toBe(true);
    expect(rows.some((model) => (model.context_length ?? 0) > 0)).toBe(true);
    expect(rows.some((model) => (model.max_output_length ?? 0) > 0)).toBe(true);

    const priced = rows.filter(
      (model) => typeof model.pricing_input === "number" && typeof model.pricing_output === "number",
    );
    expect(priced.length).toBeGreaterThan(rows.length / 2);
    expect(priced.every((model) => model.pricing_input! >= 0 && model.pricing_output! >= 0)).toBe(true);

    const sample = priced.find((model) => (model.context_length ?? 0) > 0);
    expect(sample).toBeDefined();
    expect(matchOpenRouterModel(sample!.id, rows)?.id).toBe(sample!.id);
  }, 60_000);

  test("enriches an empty model record from live metadata and pricing", async () => {
    const catalog = (await fetchOpenRouterCatalog()) ?? [];
    const sample = catalog.find(
      (model) => model.pricing && model.pricing_input != null && model.context_length != null,
    );
    expect(sample).toBeDefined();

    const parsed = emptyParsedModel(sample!.id);
    const enriched = enrichParsedModel(parsed, catalog);
    expect(enriched).toBe(true);
    expect(parsed.pricing).toEqual(sample!.pricing ?? null);
    expect(parsed.context_length).toBe(sample!.context_length ?? null);
    expect(parsed.description.length).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(!live)("OpenRouter gateway integration (live)", () => {
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  let adminToken = "";
  let gatewayKey = "";
  let providerId = "";
  let providerKeyId = "";
  let model = "";

  beforeAll(async () => {
    gateway = await startGateway();
    const admin = await login(gateway.base, "admin@enterprise.test");
    adminToken = admin.accessToken;

    const provider = await request(gateway.base, "/api/admin/providers", {
      token: adminToken,
      body: { name: "openrouter-live", openaiBaseUrl: apiBaseUrl, apiKey },
    });
    expect(provider.response.status).toBe(200);
    providerId = provider.data.provider.id;
    // Provider creation imports the upstream registry through the real /models.
    expect(provider.data.sync?.openai?.added ?? 0).toBeGreaterThan(0);

    const providers = await request(gateway.base, "/api/admin/providers", { token: adminToken });
    expect(providers.response.status).toBe(200);
    const stored = (providers.data.providers as Array<{ id: string; keys: Array<{ id: string }> }>).find(
      (row) => row.id === providerId,
    );
    providerKeyId = stored?.keys[0]?.id ?? "";
    expect(providerKeyId).not.toBe("");

    const models = await request(gateway.base, "/api/admin/models", { token: adminToken });
    expect(models.response.status).toBe(200);
    const ids = (models.data.models as Array<{ id: string }>).map((row) => row.id);
    // `openrouter/free` is the documented smoke model; fall back to any free
    // variant so the suite keeps working if the alias is retired.
    model = ids.includes("openrouter/free") ? "openrouter/free" : (ids.find((id) => id.endsWith(":free")) ?? "");
    expect(model).not.toBe("");

    const alice = await createUser(gateway.base, adminToken, "openrouter-live@enterprise.test");
    const key = await request(gateway.base, "/api/keys", { token: alice.accessToken, body: { name: "openrouter-live" } });
    expect(key.response.status).toBe(200);
    gatewayKey = key.data.token;
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
  });

  const completion = (body: Record<string, unknown>) =>
    fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "Say pong" }], ...body }),
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS - 10_000),
    });

  test("proxies a non-streaming completion with the stored provider key", async () => {
    const response = await completion({});
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      choices?: Array<{ message?: { role?: string } }>;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    expect(Array.isArray(body.choices)).toBe(true);
    expect(body.choices!.length).toBeGreaterThan(0);
    expect(body.choices![0]!.message?.role).toBe("assistant");
    // Upstream usage survives the proxy, so the gateway can bill/account it.
    expect(body.usage?.prompt_tokens ?? 0).toBeGreaterThan(0);
    expect(body.usage!.total_tokens ?? 0).toBeGreaterThanOrEqual(body.usage!.prompt_tokens ?? 0);
  }, LIVE_TIMEOUT_MS);

  test("relays a streaming completion as incremental SSE", async () => {
    const response = await completion({ stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    expect(data.filter((line) => line !== "[DONE]").length).toBeGreaterThan(1);
    expect(data).toContain("[DONE]");
    const chunks = data
      .filter((line) => line !== "[DONE]")
      .map((line) => JSON.parse(line) as { choices?: unknown[]; error?: unknown });
    expect(chunks.some((chunk) => Array.isArray(chunk.choices) && chunk.choices.length > 0)).toBe(true);
    expect(chunks.every((chunk) => chunk.error === undefined)).toBe(true);
  }, LIVE_TIMEOUT_MS);

  test("serves the live catalog lookup used by the dashboard", async () => {
    const lookup = await request(gateway.base, `/api/admin/models/lookup-openrouter?q=${encodeURIComponent(model)}`, {
      token: adminToken,
    });
    expect(lookup.response.status).toBe(200);
    expect(typeof lookup.data?.match?.id).toBe("string");
    const inputPricing = lookup.data.match.pricing_input;
    expect(inputPricing === null || typeof inputPricing === "number").toBe(true);
  }, 60_000);

  test("rejects a request that carries no gateway key", async () => {
    const response = await fetch(`${gateway.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { message?: string } };
    expect(typeof body.error?.message).toBe("string");
  }, 30_000);

  test("surfaces a rejected upstream key as a JSON envelope without leaking it", async () => {
    const rejectedKey = "sk-or-v1-invalid-credential-for-tests";
    const patched = await request(gateway.base, `/api/admin/providers/${providerId}/keys/${providerKeyId}`, {
      token: adminToken,
      method: "PATCH",
      body: { apiKey: rejectedKey },
    });
    expect(patched.response.status).toBe(200);

    const response = await completion({});
    const text = await response.text();
    // Upstream rejected the key; the client gets the same-protocol envelope.
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(text).not.toContain(rejectedKey);
    expect(text).not.toContain("sk-or-v1-");
    const body = JSON.parse(text) as { error?: { message?: string } };
    expect(typeof body.error?.message).toBe("string");

    // A rejected credential is a request outcome, never a gateway crash.
    expect((await fetch(`${gateway.base}/api/health`)).ok).toBe(true);
  }, LIVE_TIMEOUT_MS);
});
