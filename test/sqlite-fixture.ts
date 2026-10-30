import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { findFreePort } from "./free-port";

/**
 * Fixture for the SQLite contention and backup suites.
 *
 * Temporary state lives under ./tmp/ INSIDE the repository: the suite owns
 * those directories and removes them in teardown, so nothing outside the repo
 * is ever created, moved or deleted.
 */

const repoRoot = path.join(import.meta.dir, "..");
export const tmpRoot = path.join(repoRoot, "tmp");
export const testSecret = "sqlite-contention-secret-0123456789";
export const testPassword = "contention-test-password-123";

export function freshDir(name: string): string {
  const dir = path.join(tmpRoot, name);
  removeTreeSync(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a directory tree.
 *
 * On Windows a SQLite file stays mapped in the process that opened it until
 * the runtime's file handle is actually released, which \`Database.close()\`
 * does not guarantee synchronously (measured: EBUSY persists for >1s after
 * close in the same process). Retrying in-process first handles the common
 * case; when the handle is still mapped, a short-lived child process removes
 * the tree, because the child never opened the database.
 */
export async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
      return;
    } catch (error) {
      if (attempt === 19) {
        const child = Bun.spawn(
          [process.execPath, "-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:20,retryDelay:50})", dir],
          { stdout: "ignore", stderr: "pipe" },
        );
        const code = await child.exited;
        if (code !== 0) {
          const stderr = await new Response(child.stderr).text();
          throw new Error("could not remove test directory " + dir + ": " + (stderr || String(error)), { cause: error });
        }
        return;
      }
      Bun.sleepSync(25);
    }
  }
}

/** Synchronous best effort, for setup paths where a failure is fatal anyway. */
export function removeTreeSync(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    // A stale directory from a previous run is replaced by a fresh one below.
  }
}

export interface GatewayHandle {
  base: string;
  dir: string;
  dataDir: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** Everything the child wrote to stderr so far. */
  stderr: () => string;
  stop: () => Promise<void>;
}

export async function startGateway(options: { dir: string; env?: Record<string, string> }): Promise<GatewayHandle> {
  const dir = options.dir;
  const dataDir = path.join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  const port = await findFreePort();
  const base = "http://127.0.0.1:" + port;
  const proc = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      GATEWAY_SECRET: testSecret,
      ADMIN_EMAIL: "admin@contention.test",
      ADMIN_PASSWORD: testPassword,
      TRUST_PROXY: "false",
      TRUSTED_PROXY_CIDRS: "",
      LIMIT_IP_PER_MIN: "60000",
      LIMIT_AUTH_PER_MIN: "6000",
      ...options.env,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain stderr continuously: a full pipe would block the child, and the
  // collected text is what makes a crash diagnosable.
  const chunks: string[] = [];
  const drain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      chunks.push(decoder.decode(chunk, { stream: true }));
      if (chunks.length > 4000) chunks.splice(0, 2000);
    }
  })().catch(() => undefined);
  const handle: GatewayHandle = {
    base,
    dir,
    dataDir,
    proc,
    stderr: () => chunks.join(""),
    stop: async () => {
      try { proc.kill(); } catch {}
      await Promise.race([proc.exited, Bun.sleep(5000)]);
      await drain;
    },
  };
  const deadline = Date.now() + 60_000;
  while (true) {
    if (proc.exitCode !== null) {
      const log = handle.stderr().slice(-4000);
      await handle.stop();
      throw new Error("Gateway exited during boot:\n" + log);
    }
    try {
      const health = await fetch(base + "/api/health");
      await health.text();
      if (health.ok) break;
    } catch {}
    if (Date.now() > deadline) {
      const log = handle.stderr().slice(-4000);
      await handle.stop();
      throw new Error("Gateway did not become healthy in 60s:\n" + log);
    }
    await Bun.sleep(100);
  }
  return handle;
}

export async function request(base: string, route: string, options: { token?: string; method?: string; body?: unknown } = {}) {
  const response = await fetch(base + route, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.token ? { Authorization: "Bearer " + options.token } : {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}

export async function login(base: string, email: string): Promise<{ accessToken: string; user: { id: string } }> {
  const result = await request(base, "/api/auth/login", { body: { email, password: testPassword } });
  if (result.response.status !== 200) throw new Error("Login failed: " + result.response.status + " " + result.text);
  return result.data;
}

/** Poll a synchronous predicate until it holds, or fail with \`message\`. */
export async function waitFor(condition: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(25);
  }
}
