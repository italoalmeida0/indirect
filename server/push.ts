import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import webpush from "web-push";

import { DATA_DIR, NODE_ENV, PUBLIC_URL } from "./config";
import { db } from "./db";
import { ApiError } from "./http";
import { isBlockedAddress, isIPv4Literal, validateExternalUrl } from "./safe-fetch";

/**
 * Web Push for turn-end notifications with no tab open.
 *
 * Flow: the browser subscribes its PushManager (VAPID) and POSTs the
 * subscription here; when the relay sees a turn finish while the user has
 * zero connected tabs, it fans out an encrypted push per subscription.
 * Payloads carry only display text (title/body/url) — never secrets.
 */

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
}

export interface TurnPush {
  /** Public session title (or id fallback), safe for the lock screen. */
  title: string;
  /** Host display name. */
  host: string;
  /** "done" | "error" | "cancelled" — varies the notification text. */
  disposition: "done" | "error" | "cancelled";
  /** Deep link the Service Worker opens on click. */
  url: string;
}

const VAPID_FILE = path.join(DATA_DIR, "vapid.json");

function loadVapidKeys(): { publicKey: string; privateKey: string } {
  try {
    if (existsSync(VAPID_FILE)) {
      const raw = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as {
        publicKey?: unknown;
        privateKey?: unknown;
      };
      if (typeof raw.publicKey === "string" && typeof raw.privateKey === "string") {
        return { publicKey: raw.publicKey, privateKey: raw.privateKey };
      }
    }
  } catch {}
  const keys = webpush.generateVAPIDKeys();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  } catch (e) {
    console.warn("[PUSH] could not persist VAPID keys:", e);
  }
  return keys;
}

const vapidKeys = loadVapidKeys();
webpush.setVapidDetails(`mailto:${process.env.ADMIN_EMAIL || "admin@localhost"}`, vapidKeys.publicKey, vapidKeys.privateKey);

/** Public VAPID key the browser uses in pushManager.subscribe(). */
export function vapidPublicKey(): string {
  return vapidKeys.publicKey;
}

const DEFAULT_PUSH_HOST_PATTERNS = [
  "*.googleapis.com",
  "*.google.com",
  "*.push.services.mozilla.com",
  "*.push.apple.com",
  "*.notify.windows.com",
] as const;

const SAFE_DNS_SUFFIX_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

function hostMatchesPattern(host: string, rawPattern: string): boolean {
  const pattern = rawPattern.trim().toLowerCase().replace(/\.+$/, "");
  if (!pattern) return false;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (!SAFE_DNS_SUFFIX_RE.test(suffix)) return false;
    return host.endsWith(`.${suffix}`);
  }
  if (pattern.startsWith(".")) {
    const suffix = pattern.slice(1);
    if (!SAFE_DNS_SUFFIX_RE.test(suffix)) return false;
    return host.endsWith(`.${suffix}`);
  }
  if (!SAFE_DNS_SUFFIX_RE.test(pattern)) return false;
  return host === pattern;
}

export function isAllowedPushHost(hostname: string, extraHostsRaw = process.env.PUSH_EXTRA_HOSTS || ""): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (!host || isIPv4Literal(host) || host.includes(":") || !SAFE_DNS_SUFFIX_RE.test(host)) return false;
  if (DEFAULT_PUSH_HOST_PATTERNS.some((p) => hostMatchesPattern(host, p))) return true;
  if (!extraHostsRaw.trim()) return false;
  for (const part of extraHostsRaw.split(",")) {
    if (hostMatchesPattern(host, part)) return true;
  }
  return false;
}

/**
 * Validate a Web Push subscription endpoint against SSRF:
 *  - HTTPS only on default port 443, no embedded credentials;
 *  - hostname must match known Web Push vendor domains (or safe entries in PUSH_EXTRA_HOSTS);
 *  - DNS must resolve strictly to public non-blocked IP addresses.
 */
export async function validatePushEndpoint(
  endpoint: string,
  opts: { lookup?: (host: string) => Promise<string[]>; extraHosts?: string } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError(400, "invalid push endpoint URL");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "push endpoint must use https");
  }
  if (url.username || url.password) {
    throw new ApiError(400, "push endpoint must not include credentials");
  }
  const hostLower = url.hostname.toLowerCase();
  const loopbackTest =
    NODE_ENV === "test" &&
    process.env.PUSH_ALLOW_LOOPBACK === "true" &&
    (hostLower === "127.0.0.1" || hostLower === "[::1]" || hostLower === "localhost");
  if (loopbackTest) return url;

  if (url.port !== "" && url.port !== "443") {
    throw new ApiError(400, "push endpoint must use standard port 443");
  }
  const host = hostLower.replace(/\.+$/, "");
  if (isBlockedAddress(host) || !isAllowedPushHost(host, opts.extraHosts)) {
    throw new ApiError(400, "push endpoint host is not an allowed push service");
  }
  try {
    await validateExternalUrl(url.toString(), { allowedProtocols: ["https:"], lookup: opts.lookup });
  } catch {
    throw new ApiError(400, "push endpoint could not be resolved to a public address");
  }
  return url;
}

export function listSubscriptions(userId: string): PushSubscriptionRow[] {
  return db
    .prepare<PushSubscriptionRow, [string]>("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId);
}

/**
 * Upsert a push subscription for `userId`. Never transfers or overwrites an
 * endpoint already owned by a different user; returns `false` on cross-user
 * conflict.
 */
export function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  label: string,
): boolean {
  const res = db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh,
       auth = excluded.auth, label = excluded.label
     WHERE push_subscriptions.user_id = excluded.user_id`,
  ).run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, label, Date.now());
  return res.changes > 0;
}

export function deleteSubscription(userId: string, endpoint: string): boolean {
  const row = db
    .prepare<{ endpoint: string }, [string, string]>("SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .get(userId, endpoint);
  if (!row) return false;
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  return true;
}

/** Push payload: display-only, no secrets (lock screens show these). */
export function buildTurnPayload(push: TurnPush): string {
  const title =
    push.disposition === "error"
      ? `Turn failed — ${push.title}`
      : push.disposition === "cancelled"
        ? `Turn cancelled — ${push.title}`
        : `Turn finished — ${push.title}`;
  return JSON.stringify({
    title,
    body: `${push.host} · tap to open`,
    url: push.url || `${PUBLIC_URL}/#/code`,
    // Unique per event so the OS stacks instead of replacing (same
    // behavior as the in-tab Notification tag).
    tag: `turn-${push.host}-${push.title}-${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`,
  });
}

/**
 * Fire-and-forget fan-out. Never throws: delivery failures only log, and
 * dead subscriptions (410/404 from the push service) are pruned so the
 * table does not rot.
 */
export async function sendTurnPush(userId: string, push: TurnPush): Promise<void> {
  const subs = listSubscriptions(userId);
  if (subs.length === 0) return;
  const payload = buildTurnPayload(push);
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await validatePushEndpoint(s.endpoint);
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 },
        );
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          try {
            db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(s.endpoint, userId);
          } catch {}
        } else {
          console.warn(`[PUSH] send failed (${code ?? e?.message ?? e})`);
        }
      }
    }),
  );
}
