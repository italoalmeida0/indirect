import { b64uEncode } from "../server/crypto";

interface Authorization { nonce: string; challenge: string; redirectUri: string; state: string; subject: string; claims: Record<string, unknown>; badSignature: boolean; algorithm: string }
export async function startMockOidc(algorithm: "RS256" | "ES256" = "RS256") {
  let signingAlgorithm = algorithm;
  const generate = async () => await crypto.subtle.generateKey(signingAlgorithm === "RS256" ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  let pair = await generate(), kid = "key-1", serial = 1;
  let issuer = "";
  const codes = new Map<string, Authorization>();
  const metrics = { tokenRequests: 0, validPkce: 0, jwksRequests: 0 };
  let next = { subject: "employee-subject", claims: {} as Record<string, unknown>, badSignature: false, algorithm: signingAlgorithm as string };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256", "ES256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"] });
      if (url.pathname === "/jwks") { metrics.jwksRequests++; return Response.json({ keys: [{ ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid, alg: signingAlgorithm, use: "sig" }] }, { headers: { "Cache-Control": "max-age=300" } }); }
      if (url.pathname === "/authorize") {
        if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("client_id") !== "indirect-test" || url.searchParams.get("code_challenge_method") !== "S256" || url.searchParams.get("scope") !== "openid") return Response.json({ error: "invalid_authorization_request" }, { status: 400 });
        const code = crypto.randomUUID();
        const authorization = { ...next, nonce: url.searchParams.get("nonce")!, state: url.searchParams.get("state")!, challenge: url.searchParams.get("code_challenge")!, redirectUri: url.searchParams.get("redirect_uri")! };
        codes.set(code, authorization);
        const callback = new URL(authorization.redirectUri);
        callback.search = new URLSearchParams({ code, state: authorization.state, iss: issuer }).toString();
        return new Response(null, { status: 303, headers: { Location: callback.href } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        metrics.tokenRequests++;
        const form = new URLSearchParams(await req.text());
        const code = form.get("code")!, authorization = codes.get(code);
        codes.delete(code);
        if (!authorization || form.get("grant_type") !== "authorization_code" || form.get("redirect_uri") !== authorization.redirectUri) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const digest = b64uEncode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
        if (digest !== authorization.challenge) return Response.json({ error: "invalid_pkce" }, { status: 400 });
        metrics.validPkce++;
        const now = Math.floor(Date.now() / 1000);
        const header = b64uEncode(new TextEncoder().encode(JSON.stringify({ alg: authorization.algorithm, kid })));
        const payload = b64uEncode(new TextEncoder().encode(JSON.stringify({ iss: issuer, aud: "indirect-test", sub: authorization.subject, nonce: authorization.nonce, iat: now, exp: now + 300, ...authorization.claims })));
        const sig = new Uint8Array(await crypto.subtle.sign(signingAlgorithm === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
        if (authorization.badSignature) sig[0] = sig[0]! ^ 1;
        return Response.json({ id_token: `${header}.${payload}.${b64uEncode(sig)}`, token_type: "Bearer", access_token: "controlled-test-access-token" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer = server.url.origin;
  return {
    issuer, metrics,
    identity(subject = "employee-subject", claims: Record<string, unknown> = {}, options: { badSignature?: boolean; algorithm?: string } = {}) { next = { subject, claims, badSignature: options.badSignature ?? false, algorithm: options.algorithm ?? signingAlgorithm }; },
    async rotate(algorithm = signingAlgorithm) { signingAlgorithm = algorithm; pair = await generate(); kid = `key-${++serial}`; },
    async stop() { await server.stop(true); },
  };
}

export function responseCookies(response: Response, prefix?: string): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]!).filter((value) => !prefix || value.startsWith(prefix)).join("; ");
}

export async function beginOidc(base: string) {
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: "manual" });
  if (start.status !== 303) throw new Error(`OIDC start failed: ${start.status} ${await start.text()}`);
  const flowCookie = responseCookies(start);
  const authorize = await fetch(start.headers.get("location")!, { redirect: "manual" });
  if (authorize.status !== 303) throw new Error(`Mock authorize failed: ${authorize.status}`);
  const callback = new URL(authorize.headers.get("location")!);
  return { flowCookie, callback: `${base}${callback.pathname}${callback.search}`, authorizationUrl: start.headers.get("location")! };
}

export async function finishOidc(base: string, flow: Awaited<ReturnType<typeof beginOidc>>) {
  const callback = await fetch(flow.callback, { headers: { Cookie: flow.flowCookie }, redirect: "manual" });
  if (callback.status !== 303) return { response: callback, data: await callback.json() as any, callback };
  const completeCookie = responseCookies(callback, "indirect-oidc-login=");
  const response = await fetch(`${base}/api/auth/oidc/complete`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: completeCookie }, body: "{}" });
  return { response, data: await response.json() as any, callback };
}
