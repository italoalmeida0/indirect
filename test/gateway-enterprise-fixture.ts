import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findFreePort } from "./free-port";

const root = path.join(import.meta.dir, "..");
export const testSecret = "enterprise-regression-secret-0123456789";
export const testPassword = "enterprise-test-password-123";

export async function startGateway(env: Record<string, string> = {}, existingDir?: string) {
  const dir = existingDir ?? mkdtempSync(path.join(tmpdir(), "indirect-enterprise-test-"));
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test", DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1",
      GATEWAY_SECRET: testSecret, ADMIN_EMAIL: "admin@enterprise.test", ADMIN_PASSWORD: testPassword,
      TRUST_PROXY: "false", TRUSTED_PROXY_CIDRS: "", LIMIT_IP_PER_MIN: "30000",
      LIMIT_AUTH_PER_MIN: "1000", LIMIT_USER_RPM: "600", LIMIT_USER_CONCURRENCY: "32",
      LIMIT_GLOBAL_CONCURRENCY: "256", DEFAULT_KEY_CONCURRENCY: "16", ...env,
    },
    stdout: "ignore", stderr: "pipe",
  });
  const log = new Response(proc.stderr).text();
  try {
    const until = Date.now() + 25_000;
    while (true) {
      if (proc.exitCode !== null) throw new Error(`Gateway exited: ${await log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > until) throw new Error("Gateway did not start");
      await Bun.sleep(100);
    }
  } catch (error) {
    proc.kill();
    await proc.exited;
    if (!existingDir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
  return {
    base, dir, proc, log,
    async killOnly() {
      proc.kill();
      await proc.exited;
    },
    async stop() {
      proc.kill();
      await proc.exited;
      // Removing the data directory can still fail with EBUSY on Windows while
      // a handle (an open SQLite reader, the virus scanner) is closing. That is
      // a teardown detail, never a test result: retry briefly, then leave the
      // directory for the OS to reap rather than failing an otherwise green
      // test.
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
          return;
        } catch (error) {
          Bun.gc(true);
          if (attempt === 5) {
            console.warn("[fixture] could not remove test directory:", (error as Error).message);
            return;
          }
          await Bun.sleep(150);
        }
      }
    },
  };
}

export async function request(base: string, route: string, options: { token?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}${route}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}

export async function login(base: string, email: string) {
  const result = await request(base, "/api/auth/login", { body: { email, password: testPassword } });
  if (result.response.status !== 200) throw new Error(`Login failed: ${result.response.status} ${result.text}`);
  return result.data as { accessToken: string; refreshToken: string; user: { id: string } };
}

export async function createUser(base: string, admin: string, email: string) {
  const created = await request(base, "/api/admin/users", { token: admin, body: { email, name: email, sendInvite: true } });
  if (created.response.status !== 200) throw new Error(`User creation failed: ${created.text}`);
  const token = decodeURIComponent(String(created.data.invite.link).split("token=")[1]!);
  const confirm = await request(base, "/api/auth/password-reset/confirm", { body: { token, password: testPassword } });
  if (confirm.response.status !== 200) throw new Error(`Invite confirmation failed: ${confirm.text}`);
  return login(base, email);
}

export async function waitUntil(condition: () => boolean, message: string, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > end) throw new Error(message);
    await Bun.sleep(20);
  }
}
