import { NODE_ENV, PUBLIC_URL } from "./config";
import { type CorporateAuthConfig, corporateClientSecret } from "./auth-policy";
import { b64uDecode, b64uEncode, timingSafeEq } from "./crypto";
import { ApiError, hasControlCharacters } from "./http";

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}
interface SigningJwk extends JsonWebKey { kid?: string }
let discoveryCache: { issuer: string; value: Discovery; expires: number } | undefined;
let keyCache: { uri: string; keys: SigningJwk[]; expires: number } | undefined;
let discoveryPending: { issuer: string; promise: Promise<Discovery> } | undefined;
let keysPending: { uri: string; promise: Promise<SigningJwk[]> } | undefined;
const encoder = new TextEncoder();

function safeEndpoint(value: unknown, kind: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new ApiError(400, `invalid OIDC ${kind}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError(400, `invalid OIDC ${kind}`); }
  const loopbackTest = NODE_ENV === "test" && process.env.OIDC_ALLOW_HTTP_LOOPBACK === "true" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopbackTest && url.protocol === "http:")) || url.username || url.password || url.hash) throw new ApiError(400, `OIDC ${kind} must use HTTPS without credentials or a fragment`);
  return url.href;
}

export function oidcCallbackUrl(): string {
  const url = new URL(PUBLIC_URL);
  if (url.username || url.password || url.hash || url.search || (url.pathname !== "/" && url.pathname !== "")) throw new ApiError(400, "PUBLIC_URL must be an origin for corporate sign-in");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && NODE_ENV !== "production")) throw new ApiError(400, "corporate sign-in requires an HTTPS PUBLIC_URL");
  return `${url.origin}/api/auth/oidc/callback`;
}

async function boundedJson(response: Response, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  if (!response.ok || !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    throw new ApiError(502, "OIDC provider returned an invalid response");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, "OIDC provider returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new ApiError(502, "OIDC provider response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(502, "OIDC provider returned invalid JSON"); }
}

async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new ApiError(502, "OIDC provider is unavailable"); }
}

export async function oidcDiscovery(config: CorporateAuthConfig): Promise<Discovery> {
  const parsed = new URL(safeEndpoint(config.issuer, "issuer"));
  if (parsed.search || parsed.href.replace(/\/$/, "") !== config.issuer.replace(/\/$/, "")) throw new ApiError(400, "invalid OIDC issuer");
  oidcCallbackUrl();
  if (discoveryCache?.issuer === config.issuer && discoveryCache.expires > Date.now()) return discoveryCache.value;
  if (discoveryPending?.issuer === config.issuer) return discoveryPending.promise;
  const promise = (async () => {
    const raw = await boundedJson(await providerFetch(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`));
    if (raw.issuer !== config.issuer) throw new ApiError(400, "OIDC discovery issuer does not match the configured issuer");
    if (raw.response_types_supported !== undefined && (!Array.isArray(raw.response_types_supported) || !raw.response_types_supported.includes("code"))) throw new ApiError(400, "OIDC provider must support the authorization code flow");
    if (raw.code_challenge_methods_supported !== undefined && (!Array.isArray(raw.code_challenge_methods_supported) || !raw.code_challenge_methods_supported.includes("S256"))) throw new ApiError(400, "OIDC provider must support S256 PKCE");
    if (raw.id_token_signing_alg_values_supported !== undefined && (!Array.isArray(raw.id_token_signing_alg_values_supported) || !raw.id_token_signing_alg_values_supported.some((algorithm) => algorithm === "RS256" || algorithm === "ES256"))) throw new ApiError(400, "OIDC provider must support RS256 or ES256 ID tokens");
    const methods = raw.token_endpoint_auth_methods_supported;
    if (methods !== undefined && (!Array.isArray(methods) || methods.some((x) => typeof x !== "string"))) throw new ApiError(400, "invalid OIDC token authentication methods");
    const value: Discovery = {
      issuer: config.issuer, authorization_endpoint: safeEndpoint(raw.authorization_endpoint, "authorization endpoint"),
      token_endpoint: safeEndpoint(raw.token_endpoint, "token endpoint"), jwks_uri: safeEndpoint(raw.jwks_uri, "signing key endpoint"),
      token_endpoint_auth_methods_supported: methods as string[] | undefined,
    };
    discoveryCache = { issuer: config.issuer, value, expires: Date.now() + 300_000 };
    return value;
  })();
  discoveryPending = { issuer: config.issuer, promise };
  try { return await promise; } finally { if (discoveryPending?.promise === promise) discoveryPending = undefined; }
}

async function signingKeys(uri: string, force: boolean): Promise<SigningJwk[]> {
  if (keysPending?.uri === uri) return keysPending.promise;
  if (keyCache?.uri === uri && keyCache.expires > Date.now() && !force) return keyCache.keys;
  const promise = (async () => {
    const response = await providerFetch(uri);
    const cacheSeconds = Number(response.headers.get("cache-control")?.match(/(?:^|,)\s*max-age=(\d+)/)?.[1] ?? 300);
    const body = await boundedJson(response);
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 64 || body.keys.some((key) => !key || typeof key !== "object" || Array.isArray(key))) throw new ApiError(502, "OIDC provider returned invalid signing keys");
    const keys = body.keys as SigningJwk[];
    keyCache = { uri, keys, expires: Date.now() + Math.max(30, Math.min(3600, cacheSeconds)) * 1000 };
    return keys;
  })();
  keysPending = { uri, promise };
  try { return await promise; } finally { if (keysPending?.promise === promise) keysPending = undefined; }
}

async function verifySignature(uri: string, kid: string, algorithm: "RS256" | "ES256", signed: string, signature: string, force = false): Promise<boolean> {
  const candidates = (await signingKeys(uri, force)).filter((key) => key.kid === kid && key.kty === (algorithm === "RS256" ? "RSA" : "EC") && (!key.alg || key.alg === algorithm) && (!key.use || key.use === "sig") && (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))) && !key.d);
  if (candidates.length !== 1) return force ? false : verifySignature(uri, kid, algorithm, signed, signature, true);
  const jwk = candidates[0]!;
  if (algorithm === "RS256" && (typeof jwk.n !== "string" || typeof jwk.e !== "string" || b64uDecode(jwk.n).byteLength < 256 || b64uDecode(jwk.n).byteLength > 1024)) return false;
  if (algorithm === "ES256" && (jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || b64uDecode(jwk.x).byteLength !== 32 || b64uDecode(jwk.y).byteLength !== 32 || b64uDecode(signature).byteLength !== 64)) return false;
  let verified: boolean;
  try {
    if (algorithm === "RS256") {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      verified = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDecode(signature) as BufferSource, encoder.encode(signed));
    } else {
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256" }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64uDecode(signature) as BufferSource, encoder.encode(signed));
    }
  } catch { return false; }
  return verified || (!force && await verifySignature(uri, kid, algorithm, signed, signature, true));
}

async function tokenHashMatches(claim: unknown, value: string): Promise<boolean> {
  if (typeof claim !== "string") return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return timingSafeEq(claim, b64uEncode(digest.slice(0, digest.length / 2)));
}

async function verifyIdToken(config: CorporateAuthConfig, discovery: Discovery, idToken: string, nonce: string, code: string, accessToken?: string): Promise<{ issuer: string; subject: string }> {
  if (idToken.length > 24 * 1024) throw new ApiError(401, "invalid OIDC ID token");
  const parts = idToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new ApiError(401, "invalid OIDC ID token");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try { header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")); claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")); }
  catch { throw new ApiError(401, "invalid OIDC ID token"); }
  if (!header || !claims || Array.isArray(header) || Array.isArray(claims) || (header.alg !== "RS256" && header.alg !== "ES256") || typeof header.kid !== "string" || !header.kid || header.kid.length > 256 || header.crit !== undefined || header.b64 !== undefined) throw new ApiError(401, "unsupported OIDC ID token");
  if (!await verifySignature(discovery.jwks_uri, header.kid, header.alg, `${parts[0]}.${parts[1]}`, parts[2]!)) throw new ApiError(401, "invalid OIDC signature");
  const now = Math.floor(Date.now() / 1000);
  const aud = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (claims.iss !== config.issuer || !Array.isArray(aud) || !aud.length || aud.length > 16 || aud.some((x) => typeof x !== "string") || !aud.includes(config.clientId) || (aud.length > 1 && claims.azp !== config.clientId) || (claims.azp !== undefined && claims.azp !== config.clientId)) throw new ApiError(401, "OIDC issuer or audience mismatch");
  if (typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 600 || claims.exp <= claims.iat || claims.exp - claims.iat > 86_400 || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30))) throw new ApiError(401, "OIDC ID token is expired or has invalid timestamps");
  if (typeof claims.nonce !== "string" || !timingSafeEq(claims.nonce, nonce) || typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 255 || hasControlCharacters(claims.sub)) throw new ApiError(401, "OIDC nonce or subject mismatch");
  if ((claims.c_hash !== undefined && !await tokenHashMatches(claims.c_hash, code)) || (claims.at_hash !== undefined && (!accessToken || !await tokenHashMatches(claims.at_hash, accessToken)))) throw new ApiError(401, "OIDC token hash mismatch");
  return { issuer: config.issuer, subject: claims.sub };
}

/** Only a server-held verifier reaches the token endpoint. No upstream body or token is logged. */
export async function exchangeOidcCode(config: CorporateAuthConfig, code: string, verifier: string, nonce: string) {
  const discovery = await oidcDiscovery(config);
  const secret = await corporateClientSecret(config);
  const methods = discovery.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: oidcCallbackUrl(), client_id: config.clientId, code_verifier: verifier });
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
  if (secret) {
    if (methods.includes("client_secret_basic")) {
      const formEncode = (text: string) => new URLSearchParams({ v: text }).toString().slice(2);
      headers.set("Authorization", `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(secret)}`).toString("base64")}`);
      form.delete("client_id");
    } else if (methods.includes("client_secret_post")) form.set("client_secret", secret);
    else throw new ApiError(400, "OIDC provider does not support this client's authentication method");
  } else if (!methods.includes("none")) throw new ApiError(400, "OIDC provider requires a client secret");
  const body = await boundedJson(await providerFetch(discovery.token_endpoint, { method: "POST", headers, body: form }), 64 * 1024);
  if (typeof body.id_token !== "string" || body.error !== undefined) throw new ApiError(401, "OIDC authorization was rejected");
  return verifyIdToken(config, discovery, body.id_token, nonce, code, typeof body.access_token === "string" ? body.access_token : undefined);
}
