import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isBlockedAddress,
  isBlockedIp,
  safeExternalFetch,
  SafeFetchError,
} from "../server/safe-fetch";
import { isAllowedPushHost, saveSubscription, validatePushEndpoint } from "../server/push";
import { handleGenUiRoute } from "../server/routes/gen-ui";
import {
  LINT_PAGE_CSP,
  lintPageHTML,
  runWidgetLint,
  WidgetLintBusyError,
  widgetLintConcurrencyStats,
} from "../server/routes/widget-lint";
import { ensureObscuraBrowser } from "../server/routes/obscura";
import { buildReactShimModule } from "../web/src/indirect-code/components/generative-ui/widget-doc";
import { OwnStreamExtractor } from "../server/proxy/own-tools";
import { extractMarkupToolCalls } from "../server/proxy/markup-tools";
import { toolHintsFromRequest } from "../server/proxy/dsml";
import { imageToDataUrl } from "../server/proxy/gateway-ir";
import { handleProxy } from "../server/proxy/index";
import { admissionSnapshot } from "../server/ratelimit";
import { invalidateModelCache } from "../server/models";
import { GATEWAY_SECRET } from "../server/config";
import {
  isHostOnline,
  relayDispositionCacheSize,
  remoteRelayWsHandlers,
  type WsData,
} from "../server/routes/relay";
import { getRequestOrigin } from "../server/routes/manifest";
import { db } from "../server/db";
import { encryptSecret, randomToken, sha256Hex } from "../server/crypto";
import { createUser, login, request, startGateway } from "./gateway-enterprise-fixture";

const gateways: Array<Awaited<ReturnType<typeof startGateway>>> = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const fn of cleanups) {
    try {
      await fn();
    } catch {}
  }
  for (const g of gateways) {
    await g.stop();
  }
});

const baseEnv = {
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  GOOGLE_CLIENT_ID: "",
};

const TINY_PNG = new Uint8Array(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

// ============================================================================
// Plan 3.1: Shared safeExternalFetch & fetchImageToDataUrl SSRF + streaming cap
// ============================================================================

describe("Plan 3.1: safeExternalFetch & image SSRF protection", () => {
  test("isBlockedIp and isBlockedAddress cover internal, special-use, IPv4-mapped IPv6 and trailing dots", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "100.64.0.1",
      "100.127.255.254",
      "169.254.169.254",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "[::ffff:a9fe:a9fe]",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.1",
      "64:ff9b::169.254.169.254",
      "2002:7f00:1::",
      "",
      "not-an-ip",
    ]) {
      expect(isBlockedIp(ip), `isBlockedIp(${ip})`).toBe(true);
    }

    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:808:808", "64:ff9b::808:808"]) {
      expect(isBlockedIp(ip), `isBlockedIp(${ip})`).toBe(false);
    }

    for (const host of ["localhost", "localhost.", "sub.localhost.", "db.internal.", "printer.local.", "gw.home.arpa."]) {
      expect(isBlockedAddress(host), `isBlockedAddress(${host})`).toBe(true);
    }
    expect(isBlockedAddress("cdn.example.org")).toBe(false);
  });

  test("safeExternalFetch rejects disallowed schemes, credentials, DNS-to-private, redirect-to-private, and redirect loops", async () => {
    let fetchHits = 0;
    const neverFetch = (async () => {
      fetchHits++;
      return new Response(TINY_PNG);
    }) as unknown as typeof fetch;

    for (const bad of [
      "file:///etc/passwd",
      "ftp://8.8.8.8/a.png",
      "https://user:pass@8.8.8.8/a.png",
      "http://127.0.0.1/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/a.png",
      "http://2130706433/a.png", // decimal 127.0.0.1
    ]) {
      await expect(safeExternalFetch(bad, { fetchImpl: neverFetch })).rejects.toBeInstanceOf(SafeFetchError);
    }
    expect(fetchHits).toBe(0);

    // DNS resolving to mixed public + private IP must be rejected before fetch.
    await expect(
      safeExternalFetch("https://rebind.example/a.png", {
        lookup: async () => ["8.8.8.8", "127.0.0.1"],
        fetchImpl: neverFetch,
      }),
    ).rejects.toMatchObject({ code: "blocked" });
    await expect(
      safeExternalFetch("https://empty.example/a.png", {
        lookup: async () => [],
        fetchImpl: neverFetch,
      }),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(fetchHits).toBe(0);

    // Redirect from public host to metadata IP is blocked before fetching hop 2.
    const seenUrls: string[] = [];
    const redirectToMeta = (async (input: string) => {
      seenUrls.push(input);
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }) as unknown as typeof fetch;
    await expect(
      safeExternalFetch("https://8.8.8.8/start.png", { fetchImpl: redirectToMeta }),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(seenUrls).toEqual(["https://8.8.8.8/start.png"]);

    // Redirect loop stops at maxRedirects (default 3 -> at most 4 calls).
    let hops = 0;
    const loopFetch = (async (input: string) => {
      hops++;
      return new Response(null, { status: 302, headers: { location: `${input}/next` } });
    }) as unknown as typeof fetch;
    await expect(
      safeExternalFetch("https://8.8.8.8/loop", { maxRedirects: 3, fetchImpl: loopFetch }),
    ).rejects.toMatchObject({ code: "redirects" });
    expect(hops).toBe(4);

    // Test-only SAFE_FETCH_ALLOW_LOOPBACK never works outside NODE_ENV=test and never unblocks metadata/private ranges.
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllow = process.env.SAFE_FETCH_ALLOW_LOOPBACK;
    try {
      process.env.NODE_ENV = "production";
      process.env.SAFE_FETCH_ALLOW_LOOPBACK = "true";
      await expect(safeExternalFetch("http://127.0.0.1/a.png", { fetchImpl: neverFetch })).rejects.toMatchObject({ code: "blocked" });
      process.env.NODE_ENV = "test";
      await expect(safeExternalFetch("http://169.254.169.254/latest/meta-data/", { fetchImpl: neverFetch })).rejects.toMatchObject({ code: "blocked" });
      await expect(safeExternalFetch("http://10.0.0.1/a.png", { fetchImpl: neverFetch })).rejects.toMatchObject({ code: "blocked" });
    } finally {
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevAllow === undefined) delete process.env.SAFE_FETCH_ALLOW_LOOPBACK;
      else process.env.SAFE_FETCH_ALLOW_LOOPBACK = prevAllow;
    }
  });

  test("safeExternalFetch enforces streaming byte cap and aborts immediately when exceeded", async () => {
    let chunksPulled = 0;
    let streamCancelled = false;
    const chunkedFetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          chunksPulled++;
          if (chunksPulled > 20) {
            ctrl.close();
            return;
          }
          ctrl.enqueue(new Uint8Array(1024));
        },
        cancel() {
          streamCancelled = true;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof fetch;

    await expect(
      safeExternalFetch("https://8.8.8.8/huge-stream.png", {
        maxBytes: 2500,
        fetchImpl: chunkedFetch,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(chunksPulled).toBeLessThanOrEqual(4);
    expect(streamCancelled).toBe(true);

    // Caller abort signal cancels in-flight fetch immediately.
    const ac = new AbortController();
    const slowFetch = (async (_url: string, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    setTimeout(() => ac.abort(), 30);
    await expect(
      safeExternalFetch("https://8.8.8.8/slow.png", { signal: ac.signal, fetchImpl: slowFetch }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  test("black-box: translated OpenAI->Anthropic proxy blocks loopback image_url SSRF", async () => {
    const gw = await startGateway(baseEnv);
    gateways.push(gw);
    const admin = await login(gw.base, "admin@enterprise.test");
    const user = await createUser(gw.base, admin.accessToken, "ssrf-block@enterprise.test");

    let internalHits = 0;
    const imgSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        internalHits++;
        return new Response(TINY_PNG, { headers: { "Content-Type": "image/png" } });
      },
    });
    let upstreamHits = 0;
    const anthStub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/messages")) {
          return new Response("{}", { status: 404 });
        }
        upstreamHits++;
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-ssrf-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        });
      },
    });
    cleanups.push(() => {
      imgSrv.stop(true);
      anthStub.stop(true);
    });

    const provRes = await request(gw.base, "/api/admin/providers", {
      token: admin.accessToken,
      body: { name: "ssrf-anth", anthropicBaseUrl: `http://127.0.0.1:${anthStub.port}/v1`, apiKey: "sk-up" },
    });
    expect(provRes.response.status).toBe(200);
    expect(
      (await request(gw.base, "/api/admin/settings", { token: admin.accessToken, method: "PATCH", body: { routingMode: "router" } })).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, "/api/admin/models", {
          token: admin.accessToken,
          body: { id: "oai-to-anth", providerId: provRes.data.provider.id, upstreamModel: "claude-ssrf-test", enabled: true },
        })
      ).response.status,
    ).toBe(200);

    const keyRes = await request(gw.base, "/api/keys", { token: user.accessToken, body: { name: "ssrf-k" } });
    const gwKey = keyRes.data.token as string;

    const proxyRes = await request(gw.base, "/v1/chat/completions", {
      token: gwKey,
      body: {
        model: "oai-to-anth",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "image_url", image_url: { url: `http://127.0.0.1:${imgSrv.port}/internal.png` } },
            ],
          },
        ],
      },
    });

    expect(proxyRes.response.status).toBe(400);
    expect(internalHits).toBe(0);
    expect(upstreamHits).toBe(0);
    expect(await imageToDataUrl(`http://127.0.0.1:${imgSrv.port}/internal.png`)).toBeNull();
  }, 30_000);
});

// ============================================================================
// Plan 3.2: Web Push SSRF allowlist & cross-user endpoint hijack protection
// ============================================================================

describe("Plan 3.2: Web Push SSRF allowlist & cross-user conflict protection", () => {
  test("validatePushEndpoint enforces https:443, vendor allowlist, PUSH_EXTRA_HOSTS, and public DNS", async () => {
    const publicDns = async () => ["142.250.185.74"];
    const privateDns = async () => ["169.254.169.254"];

    for (const okUrl of [
      "https://fcm.googleapis.com/fcm/send/abc123",
      "https://updates.push.services.mozilla.com/wpush/v2/abc123",
      "https://web.push.apple.com/Qabc123",
      "https://wns2-bl2p.notify.windows.com/?token=abc",
      "https://updates.google.com/push/abc",
    ]) {
      const parsed = await validatePushEndpoint(okUrl, { lookup: publicDns });
      expect(parsed.protocol).toBe("https:");
    }

    for (const badUrl of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://evilgoogleapis.com/fcm/send/abc",
      "https://127.0.0.1/push/probe",
      "https://169.254.169.254/latest/meta-data/",
      "https://internal.corp.example/push",
    ]) {
      await expect(validatePushEndpoint(badUrl, { lookup: publicDns })).rejects.toThrow();
    }

    // Vendor domain resolving to private/metadata IP must be rejected.
    await expect(
      validatePushEndpoint("https://fcm.googleapis.com/fcm/send/abc", { lookup: privateDns }),
    ).rejects.toThrow();

    // PUSH_EXTRA_HOSTS safe domain/suffix matching.
    expect(isAllowedPushHost("push.corp.example", "push.corp.example")).toBe(true);
    expect(isAllowedPushHost("a.push.corp.example", "*.push.corp.example")).toBe(true);
    expect(isAllowedPushHost("evil.com", "*,*.com,.net,bad host")).toBe(false);
    const extraOk = await validatePushEndpoint("https://a.push.corp.example/sub", {
      lookup: publicDns,
      extraHosts: "*.push.corp.example",
    });
    expect(extraOk.hostname).toBe("a.push.corp.example");
  });

  test("saveSubscription blocks cross-user endpoint takeover while allowing same-user updates", () => {
    const u1 = `u_push1_${randomToken(6)}`;
    const u2 = `u_push2_${randomToken(6)}`;
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomToken(12)}`;
    const now = Date.now();
    db.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, 'P1', 'user', 'active', ?)").run(
      u1,
      `${u1}@test.local`,
      now,
    );
    db.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, 'P2', 'user', 'active', ?)").run(
      u2,
      `${u2}@test.local`,
      now,
    );
    try {
      expect(saveSubscription(u1, { endpoint, keys: { p256dh: "p256dh-user1-key", auth: "auth-user1-key" } }, "Device A")).toBe(true);
      // Same user update succeeds.
      expect(saveSubscription(u1, { endpoint, keys: { p256dh: "p256dh-user1-new", auth: "auth-user1-new" } }, "Device A2")).toBe(true);
      // Different user cannot overwrite or steal u1's endpoint.
      expect(saveSubscription(u2, { endpoint, keys: { p256dh: "p256dh-attacker", auth: "auth-attacker" } }, "Hijack")).toBe(false);

      const row = db
        .prepare<{ user_id: string; p256dh: string; label: string }, [string]>(
          "SELECT user_id, p256dh, label FROM push_subscriptions WHERE endpoint = ?",
        )
        .get(endpoint);
      expect(row).toEqual({ user_id: u1, p256dh: "p256dh-user1-new", label: "Device A2" });
    } finally {
      db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
      db.prepare("DELETE FROM users WHERE id IN (?, ?)").run(u1, u2);
    }
  });

  test("black-box: POST /api/push/subscribe rejects SSRF URLs and returns 409 on cross-user endpoint collision", async () => {
    const gw = await startGateway({ ...baseEnv, PUSH_ALLOW_LOOPBACK: "false" });
    gateways.push(gw);
    const admin = await login(gw.base, "admin@enterprise.test");
    const u1 = await createUser(gw.base, admin.accessToken, "push-u1@enterprise.test");

    const keys = { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", auth: "tBHItJI5svbpez7KI4CCXg" };
    for (const bad of [
      "https://127.0.0.1:443/probe",
      "https://evil.invalid/push",
      "https://fcm.googleapis.com:8443/fcm/send/1",
      "http://fcm.googleapis.com/fcm/send/1",
    ]) {
      const res = await request(gw.base, "/api/push/subscribe", {
        token: u1.accessToken,
        body: { endpoint: bad, keys },
      });
      expect(res.response.status, bad).toBe(400);
    }

    // Also test 409 via a gateway with PUSH_ALLOW_LOOPBACK=true in test mode (no external DNS required).
    const gwLoop = await startGateway({ ...baseEnv, PUSH_ALLOW_LOOPBACK: "true" });
    gateways.push(gwLoop);
    const adminL = await login(gwLoop.base, "admin@enterprise.test");
    const a1 = await createUser(gwLoop.base, adminL.accessToken, "push-l1@enterprise.test");
    const a2 = await createUser(gwLoop.base, adminL.accessToken, "push-l2@enterprise.test");
    const ep = "https://127.0.0.1:44399/shared-endpoint";
    const s1 = await request(gwLoop.base, "/api/push/subscribe", {
      token: a1.accessToken,
      body: { endpoint: ep, keys, label: "Owner" },
    });
    expect(s1.response.status).toBe(200);
    const s2 = await request(gwLoop.base, "/api/push/subscribe", {
      token: a2.accessToken,
      body: { endpoint: ep, keys, label: "Attacker" },
    });
    expect(s2.response.status).toBe(409);

    const sql = new Database(path.join(gwLoop.dir, "gateway.db"), { readonly: true });
    try {
      const owner = sql.query<{ user_id: string; label: string }, [string]>("SELECT user_id, label FROM push_subscriptions WHERE endpoint = ?").get(ep);
      expect(owner).toEqual({ user_id: a1.user.id, label: "Owner" });
    } finally {
      sql.close();
    }
  }, 30_000);
});

// ============================================================================
// Plan 3.3: Gen-UI auth on POST /widgets & hardened GET /img
// ============================================================================

describe("Plan 3.3: Gen-UI widgets auth & image proxy dedup/concurrency/error hygiene", () => {
  test("black-box: POST /api/indirect-code/gen-ui/widgets requires auth while GET widget/module stays hash-accessible", async () => {
    const gw = await startGateway(baseEnv);
    gateways.push(gw);
    const admin = await login(gw.base, "admin@enterprise.test");
    const jsx = `export default function App() { return <div className="gu-root">ok</div>; }`;

    const unauth = await request(gw.base, "/api/indirect-code/gen-ui/widgets", {
      body: { jsx },
    });
    expect(unauth.response.status).toBe(401);

    const authed = await request(gw.base, "/api/indirect-code/gen-ui/widgets", {
      token: admin.accessToken,
      body: { jsx },
    });
    expect(authed.response.status).toBe(200);
    expect(authed.data?.id).toMatch(/^[0-9a-f]{64}$/);

    // Opaque iframe GET works without Authorization header using the 256-bit content hash.
    const docRes = await fetch(`${gw.base}${authed.data.url}`);
    expect(docRes.status).toBe(200);
    const html = await docRes.text();
    const modPath = /src="(\/api\/indirect-code\/gen-ui\/modules\/[0-9a-f]{64})"/.exec(html)?.[1];
    expect(modPath).toBeTruthy();
    const modRes = await fetch(`${gw.base}${modPath}`);
    expect(modRes.status).toBe(200);
  }, 30_000);

  test("GET /api/indirect-code/gen-ui/img deduplicates in-flight URLs, caps concurrency at 8, and hides internal network errors", async () => {
    const BASE = "http://gw.test";
    const realFetch = globalThis.fetch;
    const callImg = (u: string) =>
      handleGenUiRoute(
        "/api/indirect-code/gen-ui/img",
        new Request(`${BASE}/api/indirect-code/gen-ui/img?u=${encodeURIComponent(u)}`),
        new URL(`${BASE}/api/indirect-code/gen-ui/img?u=${encodeURIComponent(u)}`),
      ) as Promise<Response>;

    try {
      // 1. In-flight deduplication for identical URL.
      let dedupFetches = 0;
      let releaseDedup!: () => void;
      const dedupGate = new Promise<void>((r) => {
        releaseDedup = r;
      });
      (globalThis as any).fetch = async () => {
        dedupFetches++;
        await dedupGate;
        return new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } });
      };
      const sameUrl = `https://8.8.8.8/dedup-${randomToken(6)}.png`;
      const pending = Array.from({ length: 10 }, () => callImg(sameUrl));
      await Bun.sleep(20);
      releaseDedup();
      const dedupRes = await Promise.all(pending);
      expect(dedupFetches).toBe(1);
      for (const r of dedupRes) expect(r.status).toBe(200);

      // 2. Global concurrency cap <= 8 for distinct URLs.
      let current = 0;
      let peak = 0;
      (globalThis as any).fetch = async () => {
        current++;
        peak = Math.max(peak, current);
        await Bun.sleep(30);
        current--;
        return new Response(TINY_PNG, { status: 200, headers: { "content-type": "image/png" } });
      };
      const distinctUrls = Array.from({ length: 14 }, (_, i) => `https://8.8.8.8/conc-${randomToken(6)}-${i}.png`);
      const concRes = await Promise.all(distinctUrls.map((u) => callImg(u)));
      expect(peak).toBeLessThanOrEqual(8);
      expect(peak).toBeGreaterThanOrEqual(2);
      for (const r of concRes) expect(r.status).toBe(200);

      // 3. Network error hygiene: never echo internal DNS/socket errors.
      (globalThis as any).fetch = async () => {
        throw new Error("ECONNREFUSED 10.20.30.40:9200 internal-secret.corp");
      };
      const failRes = await callImg(`https://8.8.8.8/netfail-${randomToken(6)}.png`);
      expect(failRes.status).toBe(400);
      const body = (await failRes.json()) as { error?: string };
      expect(body.error).toBe("image: fetch failed");
      expect(body.error).not.toContain("ECONNREFUSED");
      expect(body.error).not.toContain("10.20.30.40");
      expect(body.error).not.toContain("internal-secret");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ============================================================================
// Plan 3.4: Obscura Widget Lint CSP & concurrency cap
// ============================================================================

describe("Plan 3.4: Obscura Widget Lint CSP, abort handling, and concurrency cap", () => {
  test("lintPageHTML injects strict CSP meta tag in <head>", () => {
    const html = lintPageHTML("{}", false, {});
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${LINT_PAGE_CSP}">`);
    expect(LINT_PAGE_CSP).toContain("default-src 'none'");
    expect(LINT_PAGE_CSP).toContain("connect-src 'none'");
    expect(LINT_PAGE_CSP).toContain("img-src data: blob:");
    expect(LINT_PAGE_CSP).toContain("script-src 'unsafe-inline' blob: data:");
  });

  test("Obscura enforces lintPageHTML CSP against http:// fetch, <img>, and <script> probes", async () => {
    const binary = await ensureObscuraBrowser();
    const hits: string[] = [];
    const probeSrv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        hits.push(new URL(req.url).pathname);
        return new Response("secret", { headers: { "content-type": "text/plain" } });
      },
    });
    const dir = mkdtempSync(path.join(tmpdir(), "gen-ui-csp-test-"));
    try {
      writeFileSync(path.join(dir, "lint.html"), lintPageHTML("{}", false, {}));
      writeFileSync(path.join(dir, "react-shim.js"), buildReactShimModule());
      writeFileSync(
        path.join(dir, "widget.js"),
        `
        let fetchBlocked = false;
        try {
          await fetch("http://127.0.0.1:${probeSrv.port}/fetch-probe");
        } catch {
          fetchBlocked = true;
        }
        const img = document.createElement("img");
        img.src = "http://127.0.0.1:${probeSrv.port}/img-probe";
        document.body.appendChild(img);
        const s = document.createElement("script");
        s.src = "http://127.0.0.1:${probeSrv.port}/script-probe.js";
        document.body.appendChild(s);
        window.__lint_result.output.push("fetchBlocked=" + fetchBlocked);
        export default function App() { return null; }
        `,
      );
      const proc = Bun.spawn(
        [binary, "fetch", `file://${path.join(dir, "lint.html")}`, "--eval", "JSON.stringify(window.__lint_result)", "--quiet", "--timeout", "10"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const out = (await new Response(proc.stdout).text()).trim();
      const parsed = JSON.parse(out) as { done?: boolean; output?: string[] };
      expect(parsed.done).toBe(true);
      expect(parsed.output).toContain("fetchBlocked=true");
      expect(parsed.output).toContain("render: ok");
      expect(hits).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      probeSrv.stop(true);
    }
  }, 60_000);

  test("runWidgetLint enforces semaphore (max 2 active, max 8 queued -> WidgetLintBusyError) and kills on AbortSignal", async () => {
    await ensureObscuraBrowser();
    const ac = new AbortController();
    const hangingReq = {
      id: "hang",
      source: `export default function App() { return <div className="gu-root">hang</div>; }`,
      test: `import "widget";\nexport function test() { return new Promise(() => {}); }`,
      signal: ac.signal,
    };

    // Start 10 requests (2 active + 8 queued) -> the 11th must reject immediately with WidgetLintBusyError (503).
    const running = Array.from({ length: 10 }, () => runWidgetLint(hangingReq));
    await Bun.sleep(50);
    const stats = widgetLintConcurrencyStats();
    expect(stats.active).toBe(2);
    expect(stats.queued).toBe(8);

    await expect(runWidgetLint({ ...hangingReq, signal: undefined })).rejects.toBeInstanceOf(WidgetLintBusyError);

    // Abort kills the active Obscura processes and clears the queue promptly.
    const abortStart = Date.now();
    ac.abort();
    const settled = await Promise.all(running);
    expect(Date.now() - abortStart).toBeLessThan(5_000);
    for (const r of settled) expect(r.ok).toBe(false);
    expect(widgetLintConcurrencyStats().active).toBe(0);
    expect(widgetLintConcurrencyStats().queued).toBe(0);
  }, 60_000);
});

// ============================================================================
// Plan 3.5: Proxy & Relay resilience fixes
// ============================================================================

describe("Plan 3.5: Proxy & Relay resilience fixes", () => {
  test("OwnStreamExtractor caps held buffer at MAX_HOLD (512 KiB) and releases safely", () => {
    const hints = toolHintsFromRequest({
      tools: [{ type: "function", function: { name: "exec_bash", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    });
    const ex = new OwnStreamExtractor(hints);
    const chunk = "a".repeat(64 * 1024);
    let emittedLen = 0;
    const first = ex.feed("```tool_call\n" + chunk);
    expect(first).toEqual([]); // still holding while under 512 KiB

    // Push past 512 KiB without closing fence -> forced verbatim release.
    for (let i = 0; i < 9; i++) {
      for (const e of ex.feed(chunk)) {
        if ("text" in e) emittedLen += e.text.length;
      }
    }
    expect(emittedLen).toBeGreaterThan(512 * 1024);
    expect(ex.committed).toBe(0);
  });

  test("markup-tools TAG_RE has no catastrophic backtracking on long whitespace or unclosed identifier runs", () => {
    const hints = toolHintsFromRequest({
      tools: [{ type: "function", function: { name: "exec_bash", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }],
    });
    const spaces = " ".repeat(50_000);
    const chars = "a".repeat(50_000);
    const payloads = [
      `<tool_call><function=exec_bash><parameter=cmd${spaces}`,
      `<tool_call><function=exec_bash><parameter name=cmd${spaces}`,
      `<tool_call><function=exec_bash${spaces}`,
      `<tool_call><invoke name=exec_bash${spaces}`,
      `<tool_calls><function=bash><parameter=${chars}`,
      `<tool_calls><function=bash><parameter name=${chars}`,
    ];
    const started = performance.now();
    for (const p of payloads) {
      const r = extractMarkupToolCalls(p, hints, "fallback");
      expect(r.changed).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(100);

    // Valid tags (bare, quoted, and with extra attributes) still parse properly.
    const valid = `<tool_call><function="exec_bash"><parameter name = "cmd" string="true">ls -la</parameter></function></tool_call>`;
    const ok = extractMarkupToolCalls(valid, hints, "fallback");
    expect(ok.changed).toBe(true);
    expect(ok.calls[0]?.name).toBe("exec_bash");
    expect(ok.calls[0]?.input).toEqual({ cmd: "ls -la" });

    const bareValid = `<tool_call><function=exec_bash><parameter=cmd>pwd</parameter></function></tool_call>`;
    const okBare = extractMarkupToolCalls(bareValid, hints, "fallback");
    expect(okBare.changed).toBe(true);
    expect(okBare.calls[0]?.input).toEqual({ cmd: "pwd" });
  });

  test("proxy concurrency slot is NOT released prematurely on abort while upstream work is unwinding", async () => {
    const uid = `u_slot_${randomToken(6)}`;
    const kid = `k_slot_${randomToken(6)}`;
    const pid = `p_slot_${randomToken(6)}`;
    const pkid = `pk_slot_${randomToken(6)}`;
    const rawKey = `gw_${randomToken(24)}`; // 3 + 48 = 51 chars
    const now = Date.now();
    const encUp = await encryptSecret("sk-up-slot", GATEWAY_SECRET);

    db.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, 'Slot', 'user', 'active', ?)").run(
      uid,
      `${uid}@test.local`,
      now,
    );
    db.prepare(
      "INSERT INTO api_keys (id, user_id, name, prefix, hash, status, created_at) VALUES (?, ?, 'k', ?, ?, 'active', ?)",
    ).run(kid, uid, rawKey.slice(0, 12), sha256Hex(rawKey), now);
    db.prepare(
      `INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, api_key_enc, enabled, priority, created_at)
       VALUES (?, ?, 'http://127.0.0.1:9/v1', NULL, ?, 1, 1, ?)`,
    ).run(pid, `slot-prov-${randomToken(4)}`, encUp, now);
    db.prepare(
      `INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
       VALUES (?, ?, 'k1', ?, 0, 'active', ?, ?)`,
    ).run(pkid, pid, encUp, now, now);
    invalidateModelCache();

    const realFetch = globalThis.fetch;
    let upstreamSignal: AbortSignal | null | undefined;
    let finishFetch!: () => void;
    let fetchStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      fetchStarted = r;
    });
    (globalThis as any).fetch = async (_input: unknown, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      fetchStarted();
      await new Promise<void>((r) => {
        finishFetch = r;
      });
      throw new Error("aborted after slow unwind");
    };

    try {
      const before = admissionSnapshot().inFlight;
      const ac = new AbortController();
      const url = new URL("http://127.0.0.1:3000/v1/chat/completions");
      const req = new Request(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${rawKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "slot-model", messages: [{ role: "user", content: "hi" }] }),
        signal: ac.signal,
      });
      const fakeServer = { requestIP: () => ({ address: "127.0.0.1" }) };

      const respPromise = handleProxy(req, url, fakeServer);
      await startedPromise;
      expect(admissionSnapshot().inFlight).toBe(before + 1);

      // Client aborts: req.signal MUST chain into the upstream controller,
      // yet the concurrency slot MUST stay held until fetch settles and finally runs.
      ac.abort();
      await Bun.sleep(20);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(admissionSnapshot().inFlight).toBe(before + 1);

      finishFetch();
      await respPromise;
      expect(admissionSnapshot().inFlight).toBe(before);
    } finally {
      globalThis.fetch = realFetch;
      db.prepare("DELETE FROM provider_keys WHERE id = ?").run(pkid);
      db.prepare("DELETE FROM providers WHERE id = ?").run(pid);
      db.prepare("DELETE FROM api_keys WHERE id = ?").run(kid);
      db.prepare("DELETE FROM users WHERE id = ?").run(uid);
      invalidateModelCache();
    }
  }, 30_000);

  test("relay caps lastDisposition at 2000 entries and drops frame without dropDaemon on transient DB error", () => {
    const userId = `u_relay_${randomToken(6)}`;
    const hostId = `host_relay_${randomToken(6)}`;
    const tokenHash = sha256Hex(`dmt_${randomToken(12)}`);
    const now = Date.now();

    db.prepare("INSERT INTO users (id, email, name, role, status, created_at) VALUES (?, ?, 'Relay', 'user', 'active', ?)").run(
      userId,
      `${userId}@test.local`,
      now,
    );
    db.prepare(
      `INSERT INTO remote_hosts (id, user_id, name, hostname, os, arch, daemon_token_hash, status, last_seen_at, created_at)
       VALUES (?, ?, 'RelayHost', 'relay.local', 'linux', 'amd64', ?, 'offline', ?, ?)`,
    ).run(hostId, userId, tokenHash, now, now);

    let closedCount = 0;
    const fakeDaemonWs = {
      data: {
        type: "daemon",
        hostId,
        userId,
        tokenHash,
        revalidateAt: Date.now() + 60_000,
      } satisfies WsData,
      send() {},
      close() {
        closedCount++;
      },
    } as any;

    try {
      remoteRelayWsHandlers.open(fakeDaemonWs);
      expect(isHostOnline(hostId)).toBe(true);

      // Push 2100 distinct session turn_end frames -> map must stay capped at <= 2000.
      for (let i = 0; i < 2100; i++) {
        remoteRelayWsHandlers.message(
          fakeDaemonWs,
          JSON.stringify({ type: "agent_event", sessionId: `sess_${i}`, event: { type: "turn_end", cancelled: false } }),
        );
      }
      expect(relayDispositionCacheSize()).toBeLessThanOrEqual(2000);
      expect(closedCount).toBe(0);

      // Simulate a transient SQLite failure during daemonLive by registering a failing mock client + throwing DB read
      // via a temporarily corrupted userId type (SQLite throws TypeError on Symbol/object binding, caught by daemonLive).
      const origUserId = fakeDaemonWs.data.userId;
      let clientReceived = 0;
      const fakeClientWs = {
        data: {
          type: "client",
          userId: origUserId,
          jti: "nonexistent",
          family: "nonexistent",
          accessExpiresAt: Date.now() + 60_000,
          expiresAt: Date.now() + 60_000,
          revalidateAt: Date.now() + 60_000,
        } satisfies WsData,
        send() {
          clientReceived++;
        },
        close() {},
      } as any;
      // Trigger catch block in daemonLive: invalid bind value throws synchronously inside stmtUserStatus.get(...).
      (fakeDaemonWs.data as any).userId = Symbol("transient-db-err");
      remoteRelayWsHandlers.message(fakeDaemonWs, JSON.stringify({ type: "session_status", sessionId: "s1", status: "running" }));
      // Socket must remain registered & unclosed (dropDaemon NOT called), while frame is dropped.
      expect(closedCount).toBe(0);
      expect(isHostOnline(hostId)).toBe(true);
      expect(clientReceived).toBe(0);
      fakeDaemonWs.data.userId = origUserId;
      void fakeClientWs;
    } finally {
      remoteRelayWsHandlers.close(fakeDaemonWs, 1000, "test");
      db.prepare("DELETE FROM remote_hosts WHERE id = ?").run(hostId);
      db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    }
  });
});

// ============================================================================
// Plan 3.6: GET /api/indirect-code/models policy/pricing & manifest.ts proxy trust
// ============================================================================

describe("Plan 3.6: indirect-code/models filtering & manifest X-Forwarded-Host trust", () => {
  test("black-box: GET /api/indirect-code/models enforces model_policies, project scope, and showModelPrices", async () => {
    const gw = await startGateway(baseEnv);
    gateways.push(gw);
    const admin = await login(gw.base, "admin@enterprise.test");
    const user = await createUser(gw.base, admin.accessToken, "models-pol@enterprise.test");

    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("{}", { status: 404 }) });
    cleanups.push(() => stub.stop(true));

    const provRes = await request(gw.base, "/api/admin/providers", {
      token: admin.accessToken,
      body: { name: "mock-anth", anthropicBaseUrl: `http://127.0.0.1:${stub.port}/v1`, apiKey: "sk-dummy" },
    });
    expect(provRes.response.status).toBe(200);
    const providerId = provRes.data.provider.id as string;

    for (const m of [
      { id: "allowed-m", pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "project-m", pricing: { prompt: "0.000003", completion: "0.000004" } },
      { id: "secret-m", pricing: { prompt: "0.000005", completion: "0.000015" } },
    ]) {
      expect(
        (
          await request(gw.base, "/api/admin/models", {
            token: admin.accessToken,
            body: { id: m.id, providerId, upstreamModel: m.id, enabled: true, pricing: m.pricing },
          })
        ).response.status,
      ).toBe(200);
    }

    // Restrict default policy to allowed-m and hide model prices.
    expect(
      (
        await request(gw.base, "/api/admin/model-policies", {
          token: admin.accessToken,
          body: { name: "DefaultAllow", kind: "default", enabled: true, models: ["allowed-m"] },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, "/api/admin/financial-policy", {
          token: admin.accessToken,
          method: "PATCH",
          body: { showModelPrices: false },
        })
      ).response.status,
    ).toBe(200);

    // Pair non-admin user host.
    const pairU = await request(gw.base, "/api/indirect-code/pair", { token: user.accessToken, body: {} });
    const connU = await request(gw.base, `/api/indirect-code/connect/${pairU.data.token}`, { body: { name: "u-host" } });
    const userDaemonToken = connU.data.daemonToken as string;

    const uModelsRes = await request(gw.base, "/api/indirect-code/models", { token: userDaemonToken });
    expect(uModelsRes.response.status).toBe(200);
    const uModels = uModelsRes.data.models as any[];
    expect(uModels.map((m) => m.id)).toEqual(["allowed-m"]);
    expect(uModels[0].pricing).toBeUndefined();

    // Assign host's API key to an active project granting project-m -> daemon sees allowed-m + project-m, still no secret-m & no pricing.
    const projRes = await request(gw.base, "/api/projects", {
      token: admin.accessToken,
      body: { code: "ENG", name: "Engineering", kind: "project" },
    });
    expect(projRes.response.status).toBe(200);
    const projectId = projRes.data.project.id as string;
    expect(
      (
        await request(gw.base, `/api/projects/${projectId}/members/${user.user.id}`, {
          token: admin.accessToken,
          method: "PUT",
          body: { role: "member" },
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await request(gw.base, "/api/admin/model-policies", {
          token: admin.accessToken,
          body: { name: "EngAllow", kind: "project", projectId, enabled: true, models: ["project-m"] },
        })
      ).response.status,
    ).toBe(200);

    const sql = new Database(path.join(gw.dir, "gateway.db"));
    try {
      const hostRow = sql.query<{ api_key_id: string }, [string]>("SELECT api_key_id FROM remote_hosts WHERE id = ?").get(connU.data.hostId);
      expect(hostRow?.api_key_id).toBeTruthy();
      sql.prepare("UPDATE api_keys SET project_id = ? WHERE id = ?").run(projectId, hostRow!.api_key_id);
    } finally {
      sql.close();
    }

    const uProjModelsRes = await request(gw.base, "/api/indirect-code/models", { token: userDaemonToken });
    expect(uProjModelsRes.response.status).toBe(200);
    const uProjModels = uProjModelsRes.data.models as any[];
    expect(uProjModels.map((m) => m.id).sort()).toEqual(["allowed-m", "project-m"]);
    for (const m of uProjModels) expect(m.pricing).toBeUndefined();

    // Admin daemon token remains exempt: sees all 3 models WITH pricing.
    const pairA = await request(gw.base, "/api/indirect-code/pair", { token: admin.accessToken, body: {} });
    const connA = await request(gw.base, `/api/indirect-code/connect/${pairA.data.token}`, { body: { name: "a-host" } });
    const aModelsRes = await request(gw.base, "/api/indirect-code/models", { token: connA.data.daemonToken });
    expect(aModelsRes.response.status).toBe(200);
    const aModels = aModelsRes.data.models as any[];
    expect(aModels.map((m) => m.id).sort()).toEqual(["allowed-m", "project-m", "secret-m"]);
    expect(aModels.find((m) => m.id === "secret-m")?.pricing?.prompt).toBe(0.000005);
  }, 30_000);

  test("black-box: /manifest.webmanifest ignores untrusted X-Forwarded-* and validates trusted X-Forwarded-*", async () => {
    // 1. TRUST_PROXY=false -> forwarded headers ignored.
    const gwUntrusted = await startGateway({ ...baseEnv, TRUST_PROXY: "false" });
    gateways.push(gwUntrusted);

    const untrustedRes = await request(gwUntrusted.base, "/manifest.webmanifest", {
      headers: {
        "X-Forwarded-Host": "evil.invalid",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(untrustedRes.response.status).toBe(200);
    expect(untrustedRes.data.id).toBe(`${gwUntrusted.base}/`);
    expect(untrustedRes.data.start_url).toBe(`${gwUntrusted.base}/#/code`);

    // 2. TRUST_PROXY=true with 127.0.0.1/32 trusted -> valid forwarded headers honored, malformed ones rejected.
    const gwTrusted = await startGateway({
      ...baseEnv,
      TRUST_PROXY: "true",
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32,::1/128",
    });
    gateways.push(gwTrusted);

    const validFwd = await request(gwTrusted.base, "/manifest.webmanifest", {
      headers: {
        "X-Forwarded-Host": "app.example.com:8443",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(validFwd.response.status).toBe(200);
    expect(validFwd.data.id).toBe("https://app.example.com:8443/");
    expect(validFwd.data.start_url).toBe("https://app.example.com:8443/#/code");

    for (const headers of [
      { "X-Forwarded-Host": "evil.invalid/inject", "X-Forwarded-Proto": "https" },
      { "X-Forwarded-Host": "user:pass@evil.invalid", "X-Forwarded-Proto": "https" },
      { "X-Forwarded-Host": "evil.invalid?q=1", "X-Forwarded-Proto": "https" },
      { "X-Forwarded-Host": "evil.invalid#frag", "X-Forwarded-Proto": "https" },
      { "X-Forwarded-Host": "evil invalid", "X-Forwarded-Proto": "https" },
      { "X-Forwarded-Host": "app.example.com", "X-Forwarded-Proto": "javascript" },
    ]) {
      const badFwd = await request(gwTrusted.base, "/manifest.webmanifest", { headers });
      expect(badFwd.response.status).toBe(200);
      expect(badFwd.data.id, JSON.stringify(headers)).toBe(`${gwTrusted.base}/`);
    }

    // 3. Unit check: getRequestOrigin ignores forwarded headers when server is omitted.
    const req = new Request("http://127.0.0.1:3000/manifest.webmanifest", {
      headers: { "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https" },
    });
    expect(getRequestOrigin(req, new URL(req.url))).toBe("http://127.0.0.1:3000");
  }, 30_000);
});
