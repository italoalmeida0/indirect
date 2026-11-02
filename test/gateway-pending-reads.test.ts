import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("worker-backed reports recheck current identity, scope and financial visibility before delivery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "indirect-pending-reads-"));
  try {
    const proc = Bun.spawn([process.execPath, "test/fixtures/pending-usage-reads.ts"], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test", DATA_DIR: dir, GATEWAY_SECRET: "pending-read-test-secret-0123456789", ANALYTICS_READERS: "1", ANALYTICS_DEADLINE_MS: "10000" },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("pending usage reads passed");
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 60_000);
