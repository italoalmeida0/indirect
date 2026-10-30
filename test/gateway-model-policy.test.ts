import { afterAll, expect, test } from "bun:test";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

/**
 * Model access policy.
 *
 * Reported gap: an ordinary user's key listed AND used both registered models,
 * because the catalog is a global availability. A company needs an economical
 * set for general use and a privileged set for approved projects, enforced at
 * the proxy for every protocol — not just hidden in the catalog, and not
 * bypassable through a fallback target.
 */

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
afterAll(async () => {
  for (const gateway of gateways) for (let i = 0; i < 5; i++) { try { await gateway.stop(); break; } catch { await Bun.sleep(150); } }
});

async function stack() {
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    if (req.method === "GET") {
      return Response.json({ data: [
        { id: "economy", context_length: 100000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "premium", context_length: 100000, top_provider: { max_completion_tokens: 1000 }, pricing: { prompt: "0.00001", completion: "0.00002" } },
      ] });
    }
    const body = await req.json() as any;
    return Response.json({ id: "x", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
  } });
  const gateway = await startGateway();
  gateways.push(gateway);
  const admin = await login(gateway.base, "admin@enterprise.test");
  expect((await request(gateway.base, "/api/admin/providers", { token: admin.accessToken, body: { name: "mock", openaiBaseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "mock-secret" } })).response.status).toBe(200);
  const sync = await request(gateway.base, "/api/admin/providers/" + (await request(gateway.base, "/api/admin/providers", { token: admin.accessToken })).data.providers[0].id + "/sync-models", { token: admin.accessToken, body: {} });
  expect(sync.response.status).toBe(200);
  expect((await request(gateway.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status).toBe(200);
  return { gateway, upstream, admin };
}

const call = (base: string, token: string, model: string, route = "/v1/chat/completions", headers: Record<string, string> = {}) => fetch(`${base}${route}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
});

test("a default policy restricts the catalog and the proxy for every protocol", async () => {
  const { gateway, upstream } = await stack();
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const user = await createUser(gateway.base, admin.accessToken, "policy-user@enterprise.test");
    const made = await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "k" } });
    const key = made.data.token as string;

    // No policy yet: everything is available (an installation is unrestricted
    // until it opts in).
    expect((await call(gateway.base, key, "premium")).status).toBe(200);

    const created = await request(gateway.base, "/api/admin/model-policies", {
      token: admin.accessToken, body: { name: "Economy only", kind: "default", models: ["economy"] },
    });
    expect(created.response.status).toBe(200);

    // The proxy refuses the excluded model on EVERY protocol surface.
    for (const [route, headers] of [
      ["/v1/chat/completions", {}],
      ["/openai/v1/chat/completions", {}],
      ["/v1/messages", { "x-api-key": key, Authorization: "" }],
      ["/anthropic/v1/messages", { "x-api-key": key, Authorization: "" }],
    ] as const) {
      const blocked = await call(gateway.base, key, "premium", route, headers);
      expect(blocked.status, route).toBe(404);
    }
    // The allowed one still works.
    expect((await call(gateway.base, key, "economy")).status).toBe(200);

    // The catalog no longer advertises what the caller cannot use.
    const catalog = await fetch(`${gateway.base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    expect(catalog.status).toBe(200);
    const ids = ((await catalog.json()) as any).data.map((m: any) => m.id);
    expect(ids).toContain("economy");
    expect(ids).not.toContain("premium");

    // A single-model read is refused rather than leaked.
    expect((await fetch(`${gateway.base}/v1/models/premium`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(404);

    // Administrators are exempt: they must reach every model to administer it.
    const adminKey = await request(gateway.base, "/api/keys", { token: admin.accessToken, body: { name: "admin-key" } });
    expect((await call(gateway.base, adminKey.data.token as string, "premium")).status).toBe(200);
  } finally { upstream.stop(true); }
}, 60_000);

test("disabling or emptying a policy restores access, and unknown ids are refused", async () => {
  const { gateway, upstream } = await stack();
  try {
    const admin = await login(gateway.base, "admin@enterprise.test");
    const user = await createUser(gateway.base, admin.accessToken, "policy2@enterprise.test");
    const made = await request(gateway.base, "/api/keys", { token: user.accessToken, body: { name: "k" } });
    const key = made.data.token as string;

    // An unknown model id is a validation error, never a silent narrowing.
    expect((await request(gateway.base, "/api/admin/model-policies", {
      token: admin.accessToken, body: { name: "Typo", kind: "default", models: ["economy", "does-not-exist"] },
    })).response.status).toBe(400);

    const created = await request(gateway.base, "/api/admin/model-policies", {
      token: admin.accessToken, body: { name: "Economy only", kind: "default", models: ["economy"] },
    });
    const policyId = created.data.policy.id as string;
    expect((await call(gateway.base, key, "premium")).status).toBe(404);

    // Disabling the policy lifts the restriction.
    expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: false } })).response.status).toBe(200);
    expect((await call(gateway.base, key, "premium")).status).toBe(200);

    // Re-enabling then EMPTYING the list also lifts it: an empty allow-list is
    // "not configured", not "nothing allowed" (that would be an outage).
    expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { enabled: true } })).response.status).toBe(200);
    expect((await call(gateway.base, key, "premium")).status).toBe(404);
    expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { models: [] } })).response.status).toBe(200);
    expect((await call(gateway.base, key, "premium")).status).toBe(200);

    // Deleting the policy leaves the installation unrestricted.
    expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "PATCH", body: { models: ["economy"] } })).response.status).toBe(200);
    expect((await call(gateway.base, key, "premium")).status).toBe(404);
    expect((await request(gateway.base, `/api/admin/model-policies/${policyId}`, { token: admin.accessToken, method: "DELETE" })).response.status).toBe(200);
    expect((await call(gateway.base, key, "premium")).status).toBe(200);
  } finally { upstream.stop(true); }
}, 60_000);
