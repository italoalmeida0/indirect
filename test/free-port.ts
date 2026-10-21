import { createServer } from "node:net";

/** Returns a free TCP port on 127.0.0.1. Test suites use this instead of
 * hardcoded ports so two concurrent `bun test` runs (or a leftover process)
 * can never collide on bind. */
export async function findFreePort(): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (typeof addr === "object" && addr) {
          const p = addr.port;
          srv.close(() => resolve(p));
        } else {
          srv.close(() => reject(new Error("no address")));
        }
      });
    });
    // In Docker containers, 127.0.0.11:41019 is often bound to internal DNS;
    // skip it so Bun.serve (binding 0.0.0.0) never hits EADDRINUSE.
    if (port !== 41019) return port;
  }
}
